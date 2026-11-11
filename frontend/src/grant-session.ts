/**
 * Grant mode for Nido accounts: ask the owner once for TurboLong's grant, read
 * it back from the account, and sign Blend calls under it with TurboLong's
 * session key (grant-key.ts) instead of the owner's passkey.
 *
 * Grants (`apply_grant`) run on Perch dev, which Nido previews on testnet
 * (nidohq/nido#356, https://356.test.nido.fyi). Nido's mainnet accounts run an
 * earlier Perch with no grants, so grant mode is testnet only; everything else
 * keeps the main-wallet flow. Calls signed by the session key are paid for by
 * a throwaway fee payer in this browser, funded by Friendbot: Nido's preview
 * runs without a relayer. The fee payer pays fees and nothing else; the
 * account's rules name the session key, not it.
 */
import { accountOrigin, openCeremonyPopup } from "@nidohq/stellar-wallets-kit-module";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  type PoolDef,
  confirmSubmittedTransaction,
  getActiveNetwork,
  getNetworkPassphrase,
  server,
  simulateGrantSubmit,
  xlmContractId,
} from "./blend";
import {
  AUTH_LIFETIME_LEDGERS,
  type CapWindow,
  type GrantCap,
  type GrantDuration,
  type GrantRule,
  type GrantView,
  accountRefusal,
  appGrantCandidates,
  authContexts,
  authDigest,
  authPayload,
  capLeft,
  capUsed,
  capWindow,
  grantBelongsTo,
  grantLabels,
  grantRequestUrl,
  ledgerToTime,
  parseGrantAnswer,
  parseGrantRules,
  ruleIdsFor,
  signaturePayload,
  signersFor,
  turboLongGrant,
  turboLongRules,
  webAuthnSigData,
  type GrantAnswer,
  type RefusalKind,
} from "./grant";
import { deleteSessionKey, loadSessionKey, sessionKeyFor, signAssertion, type SessionKey } from "./grant-key";
import { isContractAccount, nidoConfig } from "./nido";

/** Grants exist on Perch dev, previewed on testnet only. */
export const grantsSupported = (): boolean => getActiveNetwork() === "testnet";

/** The cap and duration TurboLong suggests; the owner can change both on Nido's page. */
export const DEFAULT_CAP: GrantCap = { xlm: "50", period: "day" };
export const DEFAULT_DURATION: GrantDuration = "24h";

const NULL_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FRIENDBOT = "https://friendbot.stellar.org/?addr=";
const FEE_PAYER_STORAGE = "turbolong:grant-fee-payer:testnet";

const appOrigin = () => window.location.origin;

// ── Reads ─────────────────────────────────────────────────────────────────────

async function view(contract: string, method: string, args: xdr.ScVal[] = []) {
  const tx = new TransactionBuilder(new Account(NULL_SOURCE, "0"), {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`Could not read ${method} of ${contract}`);
  return { value: scValToNative(sim.result.retval) as unknown, latestLedger: sim.latestLedger };
}

export interface AccountGrant {
  /** Whether the account has Perch dev's grant views at all. */
  supported: boolean;
  /** This origin's grant id, when it has one. */
  grantId?: number;
  rules: GrantRule[];
  latestLedger: number;
}

/**
 * This origin's grant on `account`: the first candidate id whose signer ids
 * all name this origin. A grant a recovery wiped (its generation is behind the
 * account's) authorizes nothing, so it reads as no rules.
 */
export async function readAccountGrant(account: string, origin = appOrigin()): Promise<AccountGrant> {
  const generation = await view(account, "grant_generation").catch(() => undefined);
  if (!generation) {
    const { sequence } = await server.getLatestLedger();
    return { supported: false, rules: [], latestLedger: sequence };
  }
  for (const id of appGrantCandidates(origin)) {
    const arg = [xdr.ScVal.scvU32(id)];
    const [record, signerIds, ruleSet] = await Promise.all([
      view(account, "grant", arg),
      view(account, "grant_signer_ids", arg),
      view(account, "grant_rule_set", arg),
    ]);
    const rec = record.value as { gen: bigint; rules: unknown[] } | null | undefined;
    const ids = signerIds.value as string[] | null | undefined;
    if (!rec || !ids?.length || !grantBelongsTo(ids.map(String), origin)) continue;
    if (BigInt(rec.gen) !== BigInt(generation.value as bigint))
      return { supported: true, grantId: id, rules: [], latestLedger: record.latestLedger };
    return {
      supported: true,
      grantId: id,
      rules: parseGrantRules(rec, ruleSet.value as unknown[]),
      latestLedger: record.latestLedger,
    };
  }
  return { supported: true, rules: [], latestLedger: generation.latestLedger };
}

/** The spending window the account keeps for a capped rule (`SpendRecords(id)`). */
export async function readCapWindow(account: string, rule: GrantRule): Promise<CapWindow | undefined> {
  if (!rule.cap) return undefined;
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(account).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("SpendRecords"), xdr.ScVal.scvU32(rule.id)]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const { entries } = await server.getLedgerEntries(key);
  const entry = entries[0];
  return capWindow(rule.cap, entry ? scValToNative(entry.val.contractData().val()) : undefined);
}

export type GrantStatus =
  | { state: "unavailable"; reason: "mainnet" | "classic" | "old-account" }
  | { state: "none"; hasKey: boolean }
  | {
      state: "active" | "expired";
      view: GrantView;
      /** Stroops still allowed in the current window, and the cap. */
      left: bigint;
      used: bigint;
      limit: bigint;
      periodLedgers: number;
      /** Estimated end, ms since the epoch; undefined for no expiry. */
      expiresAt: number | undefined;
      latestLedger: number;
    };

/** What TurboLong's grant for `pool` looks like on `account` right now. */
export async function grantStatus(account: string, pool: PoolDef): Promise<GrantStatus> {
  if (!grantsSupported()) return { state: "unavailable", reason: "mainnet" };
  if (!isContractAccount(account)) return { state: "unavailable", reason: "classic" };
  const [key, grant] = await Promise.all([loadSessionKey(account), readAccountGrant(account)]);
  if (!grant.supported) return { state: "unavailable", reason: "old-account" };
  const found = key && turboLongRules(grant.rules, pool.id, xlmContractId(), key.publicKeyHex, grant.latestLedger);
  if (!found) return { state: "none", hasKey: Boolean(key) };
  const window = await readCapWindow(account, found.transfer);
  const limit = found.transfer.cap?.limit ?? 0n;
  return {
    state: found.expired ? "expired" : "active",
    view: found,
    left: window ? capLeft(window, grant.latestLedger) : limit,
    used: window ? capUsed(window, grant.latestLedger) : 0n,
    limit,
    periodLedgers: found.transfer.cap?.periodLedgers ?? 0,
    expiresAt: found.validUntil === undefined ? undefined : ledgerToTime(found.validUntil, grant.latestLedger),
    latestLedger: grant.latestLedger,
  };
}

// ── Asking for the grant, and revoking it ─────────────────────────────────────

/** Make (or load) this browser's session key for `account` ahead of a click, so
 * the grant popup can open while the click still counts as a user gesture. */
export const prepareSessionKey = (account: string): Promise<SessionKey> => sessionKeyFor(account);

/**
 * Open Nido's grant page for TurboLong's two rules on `pool`. Nido shows each
 * rule (contract, functions, recipient, cap, expiry) and installs them with one
 * confirmation of the owner's passkey. Call from a click handler with a key
 * from `prepareSessionKey`.
 */
export async function requestGrant(args: {
  account: string;
  pool: PoolDef;
  key: SessionKey;
  cap?: GrantCap;
  duration?: GrantDuration;
}): Promise<GrantAnswer> {
  const { account, pool, key, cap = DEFAULT_CAP, duration = DEFAULT_DURATION } = args;
  const base = nidoConfig(getActiveNetwork()).base;
  const back = new URL(window.location.href);
  back.search = "";
  back.hash = "";
  const url = grantRequestUrl({
    accountOrigin: accountOrigin(base, account),
    account,
    publicKeyHex: key.publicKeyHex,
    origin: appOrigin(),
    returnUrl: back.toString(),
    duration,
    grants: turboLongGrant(pool.id, xlmContractId(), cap),
  });
  try {
    const { search } = await openCeremonyPopup(url, new URL(url).origin);
    return parseGrantAnswer(search);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    // Nido's window closed with no answer: the grant may still have landed.
    if (message.includes("closed")) return { outcome: "error", code: "closed" };
    throw e;
  }
}

/** Nido's page where the owner removes an app (`remove_grant`): Security →
 * Remove app. Nido takes no removal request from an app. */
export function revokeUrl(account: string): string {
  return new URL("/security/", accountOrigin(nidoConfig(getActiveNetwork()).base, account)).toString();
}

/** Forget this browser's session key: nothing here can sign under the grant
 * again, even before the owner removes it in Nido. */
export const forgetSessionKey = (account: string): Promise<void> => deleteSessionKey(account);

// ── Signing and submitting under the grant ────────────────────────────────────

/** The account refused a call signed under the grant (nothing was sent). */
export class GrantRefusedError extends Error {
  constructor(
    readonly kind: RefusalKind,
    message: string,
  ) {
    super(message);
    this.name = "GrantRefusedError";
  }
}

let feePayer: Promise<Keypair> | undefined;

async function fundedFeePayer(): Promise<Keypair> {
  if (getActiveNetwork() !== "testnet") throw new Error("Grant mode's fee payer is testnet only");
  const stored = localStorage.getItem(FEE_PAYER_STORAGE);
  const key = stored ? Keypair.fromSecret(stored) : Keypair.random();
  if (!stored) localStorage.setItem(FEE_PAYER_STORAGE, key.secret());
  const exists = await server.getAccount(key.publicKey()).then(
    () => true,
    () => false,
  );
  if (!exists) {
    const response = await fetch(FRIENDBOT + key.publicKey());
    if (!response.ok) throw new Error(`Friendbot could not fund the fee payer (HTTP ${response.status})`);
  }
  return key;
}

/** This browser's testnet fee payer, made and funded once per page. */
function testnetFeePayer(): Promise<Keypair> {
  feePayer ??= fundedFeePayer().catch((e: unknown) => {
    feePayer = undefined;
    throw e;
  });
  return feePayer;
}

export type GrantStage = "signing" | "checking" | "sending" | "confirming";

/**
 * Run `pool.submit(account, account, account, requests)` signed by TurboLong's
 * session key under its grant. The account checks the signature, the rules and
 * the cap in an enforcing simulation first, so a refused call is never sent and
 * costs nothing; its refusal comes back as `GrantRefusedError`. A call no rule
 * covers throws `GrantScopeError` before anything is signed.
 */
export async function submitUnderGrant(args: {
  account: string;
  pool: PoolDef;
  requests: xdr.ScVal;
  onStage?: (stage: GrantStage) => void;
}): Promise<string> {
  const { account, pool, requests, onStage } = args;
  if (!grantsSupported()) throw new Error("Grant mode runs on testnet only");
  const key = await loadSessionKey(account);
  if (!key) throw new Error("This browser has no session key for the account: approve TurboLong's grant first.");
  const networkPassphrase = getNetworkPassphrase();
  const [{ func, auth, latestLedger }, grant] = await Promise.all([
    simulateGrantSubmit(pool, account, requests),
    readAccountGrant(account),
  ]);
  onStage?.("signing");
  const validUntil = latestLedger + AUTH_LIFETIME_LEDGERS;
  const preferred = Object.values(grantLabels(pool.id));
  const signed: xdr.SorobanAuthorizationEntry[] = [];
  for (const recorded of auth) {
    const creds = recorded.credentials();
    const signer =
      creds.switch().name === "sorobanCredentialsAddress"
        ? Address.fromScAddress(creds.address().address()).toString()
        : undefined;
    if (signer !== account) {
      signed.push(recorded);
      continue;
    }
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(recorded.toXDR());
    const contexts = authContexts(entry.rootInvocation());
    const ruleIds = ruleIdsFor(contexts, grant.rules, key.publicKeyHex, latestLedger, preferred);
    const address = entry.credentials().address();
    address.signatureExpirationLedger(validUntil);
    const payload = signaturePayload(networkPassphrase, address.nonce(), validUntil, entry.rootInvocation());
    const assertion = await signAssertion(key, authDigest(account, payload, ruleIds), appOrigin());
    address.signature(
      authPayload(ruleIds, signersFor(ruleIds, grant.rules, key.publicKeyHex), webAuthnSigData(assertion)),
    );
    signed.push(entry);
  }

  onStage?.("checking");
  const payer = await testnetFeePayer();
  const tx = new TransactionBuilder(await server.getAccount(payer.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth: signed }))
    .setTimeout(60)
    .build();
  const enforced = await server.simulateTransaction(tx, undefined, "enforce");
  if (!rpc.Api.isSimulationSuccess(enforced)) {
    const error = (enforced as rpc.Api.SimulateTransactionErrorResponse).error;
    const refusal = accountRefusal(error);
    if (refusal) throw new GrantRefusedError(refusal.kind, refusal.text);
    throw new Error(`Simulation failed: ${error}`);
  }

  onStage?.("sending");
  const ready = rpc.assembleTransaction(tx, enforced).build();
  ready.sign(payer);
  const sent = await server.sendTransaction(ready);
  if (sent.status === "ERROR") throw new Error(`Send failed: ${sent.errorResult?.toXDR("base64")}`);
  onStage?.("confirming");
  return confirmSubmittedTransaction(sent.hash);
}
