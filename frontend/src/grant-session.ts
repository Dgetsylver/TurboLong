/**
 * Grant mode for Nido accounts: ask the owner once for TurboLong's grant, read
 * it back from the account, and sign Blend calls under it with TurboLong's
 * session key (grant-key.ts) instead of the owner's passkey.
 *
 * Nido's grant page is the same on both networks; where the rules land is not.
 * - Testnet: Nido's preview of Perch dev (nidohq/nido#356) keeps each app's
 *   rules in a grant (`apply_grant`, read with the `grant_*` views). The
 *   preview runs no relayer, so a throwaway fee payer in this browser, funded
 *   by Friendbot, sends the calls.
 * - Mainnet: Nido runs Perch 0.5.1, which has no grants; Nido writes the app's
 *   rules into the account's own policy document (`apply_doc`, read with
 *   `installed_rules` and `document`), and Nido's relayer sends the calls.
 * Either way the account's rules name the session key, and the account checks
 * them on every call; a fee payer or relayer only pays.
 */
import { openCeremonyPopup } from "@nidohq/stellar-wallets-kit-module";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  type Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  type PoolDef,
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
  parseDocRules,
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
import { isContractAccount, nidoAccountOrigin, nidoConfig } from "./nido";

/** The cap TurboLong suggests: small on mainnet. The owner can change it, and
 * the expiry, on Nido's page. */
export const defaultCap = (): GrantCap =>
  getActiveNetwork() === "mainnet" ? { xlm: "5", period: "day" } : { xlm: "50", period: "day" };
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
  /** Whether the account can hold app rules at all. */
  supported: boolean;
  /** Where they live: a grant (Perch dev) or the account's document (0.5.1). */
  stack?: "grant" | "document";
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
  if (!generation) return readDocumentRules(account);
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
      return { supported: true, stack: "grant", grantId: id, rules: [], latestLedger: record.latestLedger };
    return {
      supported: true,
      stack: "grant",
      grantId: id,
      rules: parseGrantRules(rec, ruleSet.value as unknown[]),
      latestLedger: record.latestLedger,
    };
  }
  return { supported: true, stack: "grant", rules: [], latestLedger: generation.latestLedger };
}

/** An account without grants (mainnet's Perch 0.5.1): every installed rule,
 * with functions, recipient and cap from its applied document. Only rules
 * signed by TurboLong's key are ever used. */
async function readDocumentRules(account: string): Promise<AccountGrant> {
  const read = await Promise.all([view(account, "installed_rules"), view(account, "document")]).catch(() => undefined);
  if (!read) {
    const { sequence } = await server.getLatestLedger();
    return { supported: false, rules: [], latestLedger: sequence };
  }
  const [installed, written] = read;
  const bytes = Array.isArray(written.value) ? written.value[1] : undefined;
  const doc = bytes instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
  return {
    supported: true,
    stack: "document",
    rules: parseDocRules(installed.value as unknown[], doc),
    latestLedger: installed.latestLedger,
  };
}

/** A capped rule's spending window: in the account (`SpendRecords(id)`,
 * Perch dev), or in its spending-limit policy (`AccountContext(account, id)`,
 * mainnet's 0.5.1, whose rules carry their policies). */
export async function readCapWindow(account: string, rule: GrantRule): Promise<CapWindow | undefined> {
  if (!rule.cap) return undefined;
  const entry = (contract: string, key: xdr.ScVal) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contract).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  const keys = rule.policies?.length
    ? rule.policies.map((policy) =>
        entry(
          policy,
          xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol("AccountContext"),
            new Address(account).toScVal(),
            xdr.ScVal.scvU32(rule.id),
          ]),
        ),
      )
    : [entry(account, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("SpendRecords"), xdr.ScVal.scvU32(rule.id)]))];
  const { entries } = await server.getLedgerEntries(...keys);
  const found = entries[0];
  return capWindow(rule.cap, found ? scValToNative(found.val.contractData().val()) : undefined);
}

export type GrantStatus =
  | { state: "unavailable"; reason: "classic" | "old-account" }
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
  const { account, pool, key, cap = defaultCap(), duration = DEFAULT_DURATION } = args;
  const base = nidoConfig(getActiveNetwork()).base;
  const back = new URL(window.location.href);
  back.search = "";
  back.hash = "";
  const url = grantRequestUrl({
    accountOrigin: nidoAccountOrigin(base, account),
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
  return new URL("/security/", nidoAccountOrigin(nidoConfig(getActiveNetwork()).base, account)).toString();
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

  const relayer = nidoConfig(getActiveNetwork()).relayer;
  if (relayer) return submitViaRelayer(relayer, func, signed, onStage);
  const payer = await testnetFeePayer();
  for (let attempt = 1; ; attempt++) {
    onStage?.("checking");
    const tx = new TransactionBuilder(await server.getAccount(payer.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func, auth: signed }))
      .setTimeout(60)
      .build();
    const enforced = await enforce(tx);

    onStage?.("sending");
    const ready = rpc.assembleTransaction(tx, enforced).build();
    ready.sign(payer);
    const sent = await server.sendTransaction(ready);
    if (sent.status === "ERROR") throw new Error(`Send failed: ${sent.errorResult?.toXDR("base64")}`);
    onStage?.("confirming");
    const outcome = await server.pollTransaction(sent.hash, { attempts: 30 });
    if (outcome.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
    if (outcome.status === rpc.Api.GetTransactionStatus.FAILED && attempt === 1 && trapped(outcome)) continue;
    throw new Error(
      outcome.status === rpc.Api.GetTransactionStatus.FAILED
        ? `On-chain failure: ${sent.hash}`
        : `Confirmation timed out: ${sent.hash}. Check the account before retrying.`,
    );
  }
}

/** The account's verdict on `tx` in an enforcing simulation: the signed
 * authorization runs `__check_auth` for real, so a refusal costs nothing. */
async function enforce(tx: Transaction): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const enforced = await server.simulateTransaction(tx, undefined, "enforce");
  if (rpc.Api.isSimulationSuccess(enforced)) return enforced;
  const error = (enforced as rpc.Api.SimulateTransactionErrorResponse).error;
  const refusal = accountRefusal(error);
  if (refusal) throw new GrantRefusedError(refusal.kind, refusal.text);
  throw new Error(`Simulation failed: ${error}`);
}

type RelayerAnswer = { transactionId?: string | null; hash?: string | null; status?: string | null };

/** One call to Nido's relayer (`POST <relayer>/relay`, OpenZeppelin's
 * Channels plugin), as Nido's own SDK makes it. */
async function relayerCall(relayer: string, params: object): Promise<RelayerAnswer> {
  const response = await fetch(`${relayer}/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string | null;
    data?: { code?: string; result?: RelayerAnswer } & RelayerAnswer;
  };
  if (body.success === false || !response.ok)
    throw new Error(
      [body.data?.code, body.error ?? `Nido's relayer answered ${response.status}`].filter(Boolean).join(": "),
    );
  const answer = body.data?.result ?? body.data;
  if (!answer) throw new Error("Nido's relayer gave an empty answer");
  return answer;
}

/**
 * Mainnet: check the call in an enforcing simulation (from Nido's public
 * simulation source), then hand the host function and its signed
 * authorization to Nido's relayer, which builds, pays for and submits the
 * transaction, and wait for its verdict.
 */
async function submitViaRelayer(
  relayer: string,
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
  onStage?: (stage: GrantStage) => void,
): Promise<string> {
  onStage?.("checking");
  const { networkPassphrase, simulationSource } = nidoConfig(getActiveNetwork());
  await enforce(
    new TransactionBuilder(await server.getAccount(simulationSource), { fee: BASE_FEE, networkPassphrase })
      .addOperation(Operation.invokeHostFunction({ func, auth }))
      .setTimeout(60)
      .build(),
  );
  onStage?.("sending");
  let answer = await relayerCall(relayer, {
    func: func.toXDR("base64"),
    auth: auth.map((a) => a.toXDR("base64")),
    skipWait: true,
  });
  onStage?.("confirming");
  for (let attempt = 0; attempt < 55; attempt++) {
    if (answer.status === "confirmed" && answer.hash) break;
    if (answer.status === "failed" || answer.status === "expired")
      throw new Error(
        `Nido's relayer reports the transaction ${answer.status}${answer.hash ? `: ${answer.hash}` : ""}`,
      );
    if (!answer.transactionId) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    answer = await relayerCall(relayer, { getTransaction: { transactionId: answer.transactionId } });
  }
  if (!answer.hash)
    throw new Error("Nido's relayer has not confirmed the transaction yet. Check the account before retrying.");
  const outcome = await server.pollTransaction(answer.hash, { attempts: 30 });
  if (outcome.status === rpc.Api.GetTransactionStatus.SUCCESS) return answer.hash;
  throw new Error(`Transaction ${answer.hash} ${outcome.status.toLowerCase()}. Check the account before retrying.`);
}

/**
 * A footprint drawn by the simulation can miss an entry the call writes one
 * ledger later (Blend updates its emissions index only when time has passed,
 * so a close simulated in the ledger of the open leaves `EmisData` out), and
 * the host traps. A failed transaction rolls back and consumes no nonce, so
 * the signed authorization can run once more under a fresh simulation.
 */
function trapped(outcome: rpc.Api.GetFailedTransactionResponse): boolean {
  try {
    const op = outcome.resultXdr.result().results()[0];
    const name = op?.tr().invokeHostFunctionResult().switch().name;
    return name === "invokeHostFunctionTrapped" || name === "invokeHostFunctionResourceLimitExceeded";
  } catch {
    return false;
  }
}
