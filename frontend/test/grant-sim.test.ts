/**
 * Scripted grant-mode demo against an emulated Perch dev account: approve
 * once, two actions inside the cap with no wallet prompt, then one over the
 * cap that the account refuses before anything is sent.
 *
 * The RPC is mocked. The "account" verifies what the session key signed the
 * way Perch dev's `__check_auth` does: the WebAuthn verifier's checks (type,
 * challenge = the `addr_oz_v1` digest of the chosen rule ids, UP+UV flags,
 * low-S P-256 signature over authData ‖ sha256(clientData)), a live rule per
 * context signed by that key, transfer's recipient pin, and the rolling cap.
 * "Nido" installs the rules from the very request URL TurboLong builds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Asset,
  Networks,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  type GrantRule,
  GrantScopeError,
  appGrantCandidates,
  authContexts,
  authDigest,
  fromHex,
  grantRequestUrl,
  signaturePayload,
  toBase64url,
  toHex,
  turboLongGrant,
  xlmToStroops,
} from "../src/grant";
import { type SessionKey, generateSessionKey } from "../src/grant-key";
import {
  debtStroops,
  getKnownPools,
  getPoolAssets,
  grantClosePlan,
  grantOpenPlan,
  repayWithMargin,
  setNetwork,
  type AssetPosition,
} from "../src/blend";

const keys = new Map<string, SessionKey>();
vi.mock("../src/grant-key", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/grant-key")>();
  return {
    ...real,
    loadSessionKey: async (account: string) => keys.get(account),
    saveSessionKey: async (account: string, key: SessionKey) => void keys.set(account, key),
    deleteSessionKey: async (account: string) => void keys.delete(account),
    sessionKeyFor: async (account: string) => {
      const key = keys.get(account) ?? (await real.generateSessionKey());
      keys.set(account, key);
      return key;
    },
  };
});

/** Nido's grant popup: records the request URL and answers as a closed window. */
const popups: string[] = [];
vi.mock("@nidohq/stellar-wallets-kit-module", () => ({
  openCeremonyPopup: async (url: string) => {
    popups.push(url);
    throw new Error("popup closed");
  },
}));

const { GrantRefusedError, grantStatus, prepareSessionKey, requestGrant, submitUnderGrant } = await import(
  "../src/grant-session"
);

const ORIGIN = "http://localhost:5173";
const ACCOUNT = StrKey.encodeContract(Buffer.alloc(32, 7));
const VERIFIER = "CDPT2W5ZYRHKD7ESV4OXPKYBWCCCAZRKRDAI4EAE7ACXE5ZN76F23OZP";
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** Mainnet's Perch 0.5.1 policies on an app rule: the interpreter, and on a
 * capped rule the spending limit (which keeps the window). */
const INTERPRETER = "CCLU4UY5D7JLAQJCHBHEFN7ACFZXDPHCQXA7L6MT5ALIHRPQ7BGIVMTC";
const SPENDING_LIMIT = "CAD75KDQREQCGN3HIKMAVYKZWRGOFQYDZSXB4ILFSR6OHKTJ5UDNSOKU";
const RELAYER = "https://nido-mainnet.fly.dev";

/** `none`: a contract account that is not a Perch account with app rules. */
type Stack = "grant" | "document" | "none";
let passphrase: string = Networks.TESTNET;
let XLM = Asset.native().contractId(Networks.TESTNET);
let pool = getKnownPools()[0];
let xlm = getPoolAssets(pool)[0];
let usdc = xlm;

/** Testnet's Perch dev preview (`grant`) or mainnet's Perch 0.5.1 (`document`). */
function useStack(stack: "grant" | "document") {
  chain.stack = stack;
  const net = stack === "grant" ? "testnet" : "mainnet";
  setNetwork(net);
  passphrase = net === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
  XLM = Asset.native().contractId(passphrase);
  // Testnet: RegionalStarterPack; mainnet: YieldBlox (on ice: supply only).
  pool = getKnownPools().find((p) => (net === "testnet" ? p.name === "RegionalStarterPack" : p.name === "YieldBlox"))!;
  xlm = getPoolAssets(pool).find((a) => a.id === XLM)!;
  usdc = getPoolAssets(pool).find((a) => a.symbol === "USDC")!;
}

// ── The emulated account ──────────────────────────────────────────────────────

interface Installed extends GrantRule {
  key: string;
}

const chain = {
  stack: "grant" as Stack,
  /** Make every read of the account fail with this simulation error. */
  readFailure: undefined as string | undefined,
  ledger: 1_000,
  rules: [] as Installed[],
  spends: new Map<number, { amount: bigint; ledger: number }[]>(),
  sent: [] as string[],
  pendingCharges: [] as [number, bigint][],
  ownerPrompts: 0,
  /** Make the next sent transaction trap on chain (a stale footprint). */
  trapNext: false,
  failed: new Set<string>(),
};

/** Nido's grant page: read TurboLong's request and install its rules, as one
 * owner-passkey approval (the only prompt in the demo). */
function nidoApproves(url: string, validFor = 17_280) {
  chain.ownerPrompts++;
  const params = new URL(url).searchParams;
  const key = params.get("pubkey")!;
  let id = 1;
  chain.rules = [];
  for (let i = 0; params.has(`grant.${i}.label`); i++) {
    const get = (f: string) => params.get(`grant.${i}.${f}`);
    const limit = get("limit");
    chain.rules.push({
      id: id++,
      name: get("label")!,
      contract: get("target")!,
      functions: get("functions")!.split(","),
      ...(get("to") ? { to: get("to")! } : {}),
      ...(limit && limit !== "none"
        ? { cap: { limit: xlmToStroops(limit), periodLedgers: 17_280, amountArg: 2 } }
        : {}),
      signers: [{ verifier: VERIFIER, key }],
      validUntil: chain.ledger + validFor,
      ...(chain.stack === "document"
        ? { policies: limit && limit !== "none" ? [INTERPRETER, SPENDING_LIMIT] : [INTERPRETER] }
        : {}),
      key,
    });
  }
}

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const map = (entries: [string, xdr.ScVal][]) =>
  xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));
const addr = (a: string) => new Address(a).toScVal();

function grantRecord(): xdr.ScVal {
  return map([
    ["doc_hash", nativeToScVal(Buffer.alloc(32))],
    ["gen", nativeToScVal(0n, { type: "u64" })],
    [
      "rules",
      xdr.ScVal.scvVec(
        chain.rules.map((r) =>
          map([
            ["context_type", xdr.ScVal.scvVec([sym("CallContract"), addr(r.contract!)])],
            ["id", xdr.ScVal.scvU32(r.id)],
            ["name", xdr.ScVal.scvString(r.name)],
            [
              "signers",
              xdr.ScVal.scvVec([
                xdr.ScVal.scvVec([sym("External"), addr(VERIFIER), nativeToScVal(Buffer.from(fromHex(r.key)))]),
              ]),
            ],
            ["valid_until", xdr.ScVal.scvU32(r.validUntil!)],
          ]),
        ),
      ),
    ],
  ]);
}

function ruleSet(): xdr.ScVal {
  return xdr.ScVal.scvVec(
    chain.rules.map((r) =>
      map([
        [
          "cap",
          xdr.ScVal.scvVec(
            r.cap
              ? [
                  map([
                    ["amount_arg", xdr.ScVal.scvU32(2)],
                    ["limit", nativeToScVal(r.cap.limit, { type: "i128" })],
                    ["period", xdr.ScVal.scvU32(r.cap.periodLedgers)],
                  ]),
                ]
              : [],
          ),
        ],
        [
          "conds",
          xdr.ScVal.scvVec(
            r.to
              ? [xdr.ScVal.scvVec([sym("ArgEq"), xdr.ScVal.scvU32(1), xdr.ScVal.scvVec([sym("Address"), addr(r.to)])])]
              : [],
          ),
        ],
        ["contract", addr(r.contract!)],
        ["functions", xdr.ScVal.scvVec([sym("Only"), xdr.ScVal.scvVec(r.functions!.map(sym))])],
      ]),
    ),
  );
}

/** Mainnet's `installed_rules()`: ids, scopes, signers, policies, expiry. */
function installedRules(): xdr.ScVal {
  return xdr.ScVal.scvVec(
    chain.rules.map((r) =>
      map([
        ["context_type", xdr.ScVal.scvVec([sym("CallContract"), addr(r.contract!)])],
        ["id", xdr.ScVal.scvU32(r.id)],
        ["name", xdr.ScVal.scvString(r.name)],
        ["policies", xdr.ScVal.scvVec((r.policies ?? []).map((p) => map([["policy", addr(p)]])))],
        [
          "signers",
          xdr.ScVal.scvVec([
            xdr.ScVal.scvVec([sym("External"), addr(VERIFIER), nativeToScVal(Buffer.from(fromHex(r.key)))]),
          ]),
        ],
        ["valid_until", xdr.ScVal.scvU32(r.validUntil!)],
      ]),
    ),
  );
}

/** Mainnet's `document()`: (revision, canonical JSON), as Nido's apply_doc wrote it. */
function documentView(): xdr.ScVal {
  const doc = {
    network: passphrase,
    rules: chain.rules.map((r) => ({
      name: r.name,
      scope: { type: "contract", address: r.contract },
      functions: r.functions,
      ...(r.to ? { args: [{ index: 1, pred: { type: "address-eq", address: r.to } }] } : {}),
      ...(r.cap ? { cap: { limit: r.cap.limit.toString(), "period-ledgers": r.cap.periodLedgers } } : {}),
    })),
  };
  return xdr.ScVal.scvVec([nativeToScVal(3n, { type: "u64" }), nativeToScVal(Buffer.from(JSON.stringify(doc)))]);
}

/** What the host says when a contract has no such function. */
const missing = (fn: string) =>
  `HostError: Error(WasmVm, MissingValue)\nEvent log: trying to invoke non-existent contract function, ${fn}`;

/** The account's view functions, as a simulation returns them: a value, or the
 * simulation's error. */
function view(fn: string, args: xdr.ScVal[]): xdr.ScVal | string {
  if (chain.readFailure) return chain.readFailure;
  if (chain.stack === "none") return missing(fn);
  if (chain.stack === "document") {
    if (fn === "installed_rules") return installedRules();
    if (fn === "document") return documentView();
    return missing(fn);
  }
  const ours = appGrantCandidates(ORIGIN)[0];
  const asked = args[0] ? (scValToNative(args[0]) as number) : undefined;
  const has = chain.rules.length > 0 && asked === ours;
  switch (fn) {
    case "grant_generation":
      return nativeToScVal(0n, { type: "u64" });
    case "grant":
      return has ? grantRecord() : xdr.ScVal.scvVoid();
    case "grant_signer_ids":
      return has ? xdr.ScVal.scvVec([xdr.ScVal.scvString(`${ORIGIN}#7e97b72a`)]) : xdr.ScVal.scvVoid();
    case "grant_rule_set":
      return has ? ruleSet() : xdr.ScVal.scvVec([]);
    default:
      throw new Error(`unexpected view ${fn}`);
  }
}

/** What Blend's plain submit asks the account to authorize: the submit, and
 * the transfer of every supplied or repaid unit into the pool. */
function submitAuth(requests: xdr.ScVal): xdr.SorobanAuthorizationEntry {
  const legs = scValToNative(requests) as { address: string; amount: bigint; request_type: number }[];
  const pulls = new Map<string, bigint>();
  for (const leg of legs)
    if (leg.request_type === 2 || leg.request_type === 5)
      pulls.set(leg.address, (pulls.get(leg.address) ?? 0n) + BigInt(leg.amount));
  const call = (contract: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: subs,
    });
  const transfers = [...pulls].map(([token, amount]) =>
    call(token, "transfer", [addr(ACCOUNT), addr(pool.id), nativeToScVal(amount, { type: "i128" })]),
  );
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(ACCOUNT).toScAddress(),
        nonce: xdr.Int64.fromString(String(chain.ledger)),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: call(pool.id, "submit", [addr(ACCOUNT), addr(ACCOUNT), addr(ACCOUNT), requests], transfers),
  });
}

const REFUSED_DEV = "HostError: Error(Contract, #5)\nEvent log: contract call failed: __check_auth";
const refused = (overCap = false) =>
  chain.stack === "grant"
    ? REFUSED_DEV
    : `HostError: Error(Contract, #${overCap ? 3221 : 3002})\nEvent log: contract call failed: __check_auth`;

/** Perch dev's `__check_auth` for a grant-signed entry. Returns the cap
 * charges to store, or the refusal. */
async function checkAuth(entry: xdr.SorobanAuthorizationEntry): Promise<[number, bigint][] | string> {
  const creds = entry.credentials().address();
  const payload = scValToNative(creds.signature()) as {
    context_rule_ids: number[];
    signers: unknown;
  };
  const signerEntry = creds
    .signature()
    .map()!
    .find((e) => e.key().sym().toString() === "signers")!;
  const [[signerKey, sigBytes]] = signerEntry
    .val()
    .map()!
    .map((e) => [e.key().vec()!, e.val().bytes()] as const);
  const key = toHex(signerKey[2].bytes());
  const contexts = authContexts(entry.rootInvocation());
  if (payload.context_rule_ids.length !== contexts.length) return refused();
  const charges: [number, bigint][] = [];
  for (const [i, context] of contexts.entries()) {
    const rule = chain.rules.find((r) => r.id === payload.context_rule_ids[i]);
    if (!rule || rule.contract !== context.contract || !rule.functions!.includes(context.fn)) return refused();
    if (rule.key !== key || chain.ledger > rule.validUntil!) return refused();
    if (rule.to && Address.fromScVal(context.args[1]).toString() !== rule.to) return refused();
    if (Address.fromScVal(context.args[0]).toString() !== ACCOUNT && context.fn === "transfer") return refused();
    if (rule.cap) {
      const amount = BigInt(scValToNative(context.args[2]) as bigint);
      const window = (chain.spends.get(rule.id) ?? []).filter((e) => e.ledger > chain.ledger - rule.cap!.periodLedgers);
      const used = window.reduce((s, e) => s + e.amount, 0n);
      if (used + amount > rule.cap.limit) return refused(true);
      charges.push([rule.id, amount]);
    }
  }
  // The WebAuthn verifier, on the digest the account recomputes.
  const digest = authDigest(
    ACCOUNT,
    signaturePayload(passphrase, creds.nonce(), creds.signatureExpirationLedger(), entry.rootInvocation()),
    payload.context_rule_ids,
  );
  const sig = scValToNative(xdr.ScVal.fromXDR(sigBytes)) as Record<string, Uint8Array>;
  const client = JSON.parse(new TextDecoder().decode(sig.client_data));
  if (client.type !== "webauthn.get" || client.challenge !== toBase64url(digest)) return refused();
  if ((sig.authenticator_data[32] & 0x05) !== 0x05) return refused();
  if (BigInt(`0x${toHex(sig.signature.slice(32))}`) > P256_N / 2n) return refused();
  const pub = await crypto.subtle.importKey("raw", fromHex(key), { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", sig.client_data));
  const message = new Uint8Array([...sig.authenticator_data, ...clientHash]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig.signature, message);
  return ok ? charges : refused();
}

const success = (retval: xdr.ScVal, auth: xdr.SorobanAuthorizationEntry[] = []) =>
  ({
    _parsed: true,
    id: "sim",
    latestLedger: chain.ledger,
    events: [],
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder(),
    result: { retval, auth },
  }) as unknown as rpc.Api.SimulateTransactionResponse;

const simError = (error: string) =>
  ({ id: "sim", latestLedger: chain.ledger, error, events: [], _parsed: true }) as never;

beforeEach(() => {
  popups.length = 0;
  Object.assign(chain, {
    stack: "grant",
    readFailure: undefined,
    ledger: 1_000,
    rules: [],
    spends: new Map(),
    sent: [],
    pendingCharges: [],
    ownerPrompts: 0,
    trapNext: false,
    failed: new Set(),
  });
  keys.clear();
  const store = new Map<string, string>();
  vi.stubGlobal("window", { location: { origin: ORIGIN, href: `${ORIGIN}/` } });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (a) => new Account(a, "1"));
  vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(
    async () => ({ sequence: chain.ledger }) as never,
  );
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation(async (...keys) => {
    const entries = keys.flatMap((key) => {
      const data = key.contractData();
      const owner = Address.fromScAddress(data.contract()).toString();
      const id = scValToNative(data.key()) as unknown[];
      // Perch dev: the account's SpendRecords(id). Mainnet: the spending-limit
      // policy's AccountContext(account, id). The interpreter's only key is
      // Program(account, rule) (Perch c135aca), so it has no such entry.
      const rule =
        chain.stack === "grant"
          ? owner === ACCOUNT
            ? id[1]
            : undefined
          : owner === SPENDING_LIMIT
            ? id[2]
            : undefined;
      const history = rule === undefined ? undefined : chain.spends.get(Number(rule));
      if (!history) return [];
      const total = history.reduce((sum, e) => sum + e.amount, 0n);
      const val =
        chain.stack === "grant"
          ? map([
              [
                "history",
                xdr.ScVal.scvVec(
                  history.map((e) =>
                    map([
                      ["amount", nativeToScVal(e.amount, { type: "i128" })],
                      ["ledger", xdr.ScVal.scvU32(e.ledger)],
                    ]),
                  ),
                ),
              ],
              ["total", nativeToScVal(total, { type: "i128" })],
            ])
          : map([
              ["cached_total_spent", nativeToScVal(total, { type: "i128" })],
              ["period_ledgers", xdr.ScVal.scvU32(17_280)],
              [
                "spending_history",
                xdr.ScVal.scvVec(
                  history.map((e) =>
                    map([
                      ["amount", nativeToScVal(e.amount, { type: "i128" })],
                      ["ledger_sequence", xdr.ScVal.scvU32(e.ledger)],
                    ]),
                  ),
                ),
              ],
              ["spending_limit", nativeToScVal(chain.rules.find((r) => r.cap)!.cap!.limit, { type: "i128" })],
            ]);
      return [{ val: { contractData: () => ({ val: () => val }) } }];
    });
    return { entries, latestLedger: chain.ledger } as never;
  });
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async (tx, _r, authMode) => {
    const op = (tx as Transaction).operations[0] as unknown as {
      func: xdr.HostFunction;
      auth?: xdr.SorobanAuthorizationEntry[];
    };
    const call = op.func.invokeContract();
    const contract = Address.fromScAddress(call.contractAddress()).toString();
    const fn = call.functionName().toString();
    if (contract === ACCOUNT) {
      const answer = view(fn, call.args());
      return typeof answer === "string" ? simError(answer) : success(answer);
    }
    if (contract !== pool.id || fn !== "submit") throw new Error(`unexpected call ${fn}`);
    if (authMode !== "enforce") return success(xdr.ScVal.scvVoid(), [submitAuth(call.args()[3])]);
    const verdict = await checkAuth(op.auth![0]);
    if (typeof verdict === "string") return simError(verdict);
    chain.pendingCharges = verdict;
    return success(xdr.ScVal.scvVoid());
  });
  vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(async () => {
    const hash = (chain.sent.length + 1).toString(16).padStart(64, "0");
    if (chain.trapNext) {
      // Rolled back: no spend recorded, no nonce consumed.
      chain.trapNext = false;
      chain.failed.add(hash);
      chain.sent.push(hash);
      chain.ledger += 1;
      return { status: "PENDING", hash } as never;
    }
    for (const [id, amount] of chain.pendingCharges)
      chain.spends.set(id, [...(chain.spends.get(id) ?? []), { amount, ledger: chain.ledger }]);
    chain.sent.push(hash);
    chain.ledger += 10;
    return { status: "PENDING", hash } as never;
  });
  vi.spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(async (hash) =>
    chain.failed.has(hash)
      ? ({
          status: "FAILED",
          resultXdr: new xdr.TransactionResult({
            feeCharged: xdr.Int64.fromString("100"),
            result: xdr.TransactionResultResult.txFailed([
              xdr.OperationResult.opInner(
                xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()),
              ),
            ]),
            ext: new xdr.TransactionResultExt(0),
          }),
        } as never)
      : ({ status: "SUCCESS" } as never),
  );
});

// Nido's mainnet relayer (OpenZeppelin Channels): takes the host function and
// its signed auth, lands the transaction, answers with its hash.
const relayed: unknown[] = [];
beforeEach(() => {
  relayed.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    if (!url.startsWith(`${RELAYER}/relay`)) throw new Error(`unexpected fetch ${url}`);
    const { params } = JSON.parse(init.body) as { params: { func?: string; getTransaction?: unknown } };
    if (!params.func) throw new Error("the demo never needs to poll: the first answer is confirmed");
    relayed.push(params);
    const hash = (chain.sent.length + 1).toString(16).padStart(64, "0");
    for (const [id, amount] of chain.pendingCharges)
      chain.spends.set(id, [...(chain.spends.get(id) ?? []), { amount, ledger: chain.ledger }]);
    chain.sent.push(hash);
    chain.ledger += 10;
    return new Response(
      JSON.stringify({ success: true, data: { transactionId: `tx-${hash}`, hash, status: "confirmed" } }),
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── The demo ──────────────────────────────────────────────────────────────────

async function approveOnce(cap = "40") {
  const key = await generateSessionKey();
  keys.set(ACCOUNT, key);
  nidoApproves(
    grantRequestUrl({
      accountOrigin: `https://${ACCOUNT.toLowerCase()}.356.test.nido.fyi`,
      account: ACCOUNT,
      publicKeyHex: key.publicKeyHex,
      origin: ORIGIN,
      returnUrl: `${ORIGIN}/`,
      duration: "24h",
      grants: turboLongGrant(pool, XLM, { xlm: cap, period: "day" }),
    }),
  );
}

const open = (xlmAmount: bigint, leverage: number, asset = xlm) =>
  submitUnderGrant({
    account: ACCOUNT,
    pool,
    requests: grantOpenPlan(asset, xlmAmount * 10_000_000n, leverage),
  });

describe("grant mode demo (emulated Perch dev account)", () => {
  beforeEach(() => useStack("grant"));
  it("approve once, two actions in the cap without prompts, then the account refuses one over the cap", async () => {
    await approveOnce("40");
    expect(chain.ownerPrompts).toBe(1);
    const before = await grantStatus(ACCOUNT, pool);
    expect(before).toMatchObject({ state: "active", left: 400_000_000n, limit: 400_000_000n });

    // 1. Open 10 XLM at 2x: Blend pulls 20 XLM through the capped transfer.
    await open(10n, 2);
    // 2. Close it: repay ~10 XLM of debt (with margin), withdraw the collateral.
    const debt = { asset: xlm, dTokens: 100_000_000n, dRate: 1_000_000_000_000n } as AssetPosition;
    await submitUnderGrant({ account: ACCOUNT, pool, requests: grantClosePlan(debt) });
    expect(chain.sent).toHaveLength(2);
    expect(chain.ownerPrompts).toBe(1); // no passkey or wallet prompt for either
    const after = await grantStatus(ACCOUNT, pool);
    expect(after.state).toBe("active");
    if (after.state !== "active") return;
    expect(after.used).toBe(200_000_000n + repayWithMargin(debtStroops(debt)));
    expect(after.left).toBe(400_000_000n - after.used);

    // 3. Open 10 XLM at 2x again: 20 XLM more is over the 40 XLM/day cap.
    const refused = open(10n, 2);
    await expect(refused).rejects.toBeInstanceOf(GrantRefusedError);
    await expect(refused).rejects.toThrow(/over the spending cap/);
    expect(chain.sent).toHaveLength(2); // nothing was sent
    const unchanged = await grantStatus(ACCOUNT, pool);
    expect(unchanged.state === "active" && unchanged.used).toBe(after.used);
  });

  it("re-simulates and resends once when the chain traps on a stale footprint", async () => {
    await approveOnce();
    chain.trapNext = true;
    const hash = await open(5n, 2);
    expect(chain.sent).toHaveLength(2);
    expect(chain.failed.has(chain.sent[0])).toBe(true);
    expect(hash).toBe(chain.sent[1]);
    const status = await grantStatus(ACCOUNT, pool);
    expect(status.state === "active" && status.used).toBe(100_000_000n); // charged once
  });

  /** Simulations of `pool.submit` the RPC was asked for (reads of the account aside). */
  const submitSimulations = () =>
    vi.mocked(rpc.Server.prototype.simulateTransaction).mock.calls.filter(([tx]) => {
      const op = (tx as Transaction).operations[0] as unknown as { func: xdr.HostFunction };
      return op.func.invokeContract().functionName().toString() === "submit";
    });

  it("refuses an out-of-scope token before simulating or signing", async () => {
    await approveOnce();
    const refused = open(10n, 1.5, usdc);
    await expect(refused).rejects.toBeInstanceOf(GrantScopeError);
    await expect(refused).rejects.toThrow(`does not cover transfer on ${usdc.id}`);
    expect(submitSimulations()).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
    // A covered open is simulated: the filter above does see submit calls.
    await open(1n, 1.5);
    expect(submitSimulations().length).toBeGreaterThan(0);
  });

  it("refuses a pull that would pay another pool than the XLM rule names, before simulating", async () => {
    await approveOnce();
    chain.rules.find((r) => r.to)!.to = StrKey.encodeContract(Buffer.alloc(32, 3));
    await expect(open(1n, 1.5)).rejects.toBeInstanceOf(GrantScopeError);
    expect(submitSimulations()).toHaveLength(0);
  });

  it("is refused by the account once the grant expired", async () => {
    await approveOnce();
    chain.ledger += 17_281;
    const status = await grantStatus(ACCOUNT, pool);
    expect(status.state).toBe("expired");
    // TurboLong will not sign under an expired rule.
    await expect(open(1n, 1.5)).rejects.toBeInstanceOf(GrantScopeError);
    expect(chain.sent).toHaveLength(0);
  });

  it("is refused by the account when another key signs", async () => {
    await approveOnce();
    const stranger = await generateSessionKey();
    const installed = keys.get(ACCOUNT)!;
    // The rules name TurboLong's key; pretend a different key holds its place.
    keys.set(ACCOUNT, { ...installed, privateKey: stranger.privateKey });
    await expect(open(1n, 1.5)).rejects.toBeInstanceOf(GrantRefusedError);
    expect(chain.sent).toHaveLength(0);
  });

  it("reports no grant before approval and when the browser lost its key", async () => {
    expect(await grantStatus(ACCOUNT, pool)).toEqual({ state: "none" });
    await approveOnce();
    keys.clear();
    expect(await grantStatus(ACCOUNT, pool)).toEqual({ state: "none" });
    await expect(open(1n, 1.5)).rejects.toThrow(/approve TurboLong's grant first/);
  });

  it("asks Nido with the key of the account being approved, whatever key was prepared before", async () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 9));
    const first = await prepareSessionKey(ACCOUNT);
    await requestGrant({ account: other, pool });
    const asked = new URL(popups[0]);
    expect(asked.host).toBe(`${other.toLowerCase()}--356.test.nido.fyi`);
    expect(asked.searchParams.get("pubkey")).toBe(keys.get(other)!.publicKeyHex);
    expect(asked.searchParams.get("pubkey")).not.toBe(first.publicKeyHex);
  });
});

describe("reading the account's rules", () => {
  beforeEach(() => useStack("grant"));

  it("reports an account with neither grants nor a document as unable to hold app rules", async () => {
    chain.stack = "none";
    expect(await grantStatus(ACCOUNT, pool)).toEqual({ state: "unavailable", reason: "old-account" });
  });

  it("fails, rather than reporting no grant, when a read fails for another reason", async () => {
    await approveOnce();
    chain.readFailure = "HostError: Error(Budget, ExceededLimit)";
    await expect(grantStatus(ACCOUNT, pool)).rejects.toThrow(/Could not read grant_generation/);
    await expect(open(1n, 1.5)).rejects.toThrow(/Could not read/);
    await expect(open(1n, 1.5)).rejects.not.toBeInstanceOf(GrantScopeError);

    vi.mocked(rpc.Server.prototype.simulateTransaction).mockRejectedValueOnce(new Error("429 Too Many Requests"));
    chain.readFailure = undefined;
    await expect(grantStatus(ACCOUNT, pool)).rejects.toThrow(/429/);
    expect(await grantStatus(ACCOUNT, pool)).toMatchObject({ state: "active" });
    expect(chain.sent).toHaveLength(0);
  });

  it("does the same on an account whose rules live in its document", async () => {
    useStack("document");
    await approveOnce("5");
    const real = vi.mocked(rpc.Server.prototype.simulateTransaction).getMockImplementation()!;
    vi.mocked(rpc.Server.prototype.simulateTransaction).mockImplementation(async (tx, ...rest) => {
      const fn = ((tx as Transaction).operations[0] as unknown as { func: xdr.HostFunction }).func
        .invokeContract()
        .functionName()
        .toString();
      if (fn === "installed_rules") throw new Error("fetch failed");
      return real(tx, ...rest);
    });
    await expect(grantStatus(ACCOUNT, pool)).rejects.toThrow(/fetch failed/);
  });
});

describe("mainnet grant mode (emulated Perch 0.5.1 account, Nido relayer)", () => {
  beforeEach(() => useStack("document"));
  afterEach(() => setNetwork("testnet"));

  it("approve once, two 1x supplies in the cap through the relayer, then the account refuses one over it (#3221)", async () => {
    await approveOnce("5");
    expect(chain.rules.map((r) => r.policies)).toEqual([[INTERPRETER], [INTERPRETER, SPENDING_LIMIT]]);
    expect(await grantStatus(ACCOUNT, pool)).toMatchObject({ state: "active", left: 50_000_000n, limit: 50_000_000n });

    // YieldBlox is on ice on mainnet (no borrowing), so the demo supplies at 1x.
    await open(2n, 1);
    await open(2n, 1);
    expect(relayed).toHaveLength(2);
    expect(rpc.Server.prototype.sendTransaction).not.toHaveBeenCalled();
    expect(chain.ownerPrompts).toBe(1);
    const after = await grantStatus(ACCOUNT, pool);
    expect(after).toMatchObject({ state: "active", used: 40_000_000n, left: 10_000_000n });

    const refused = open(2n, 1);
    await expect(refused).rejects.toBeInstanceOf(GrantRefusedError);
    await expect(refused).rejects.toMatchObject({ kind: "over-cap" });
    await expect(refused).rejects.toThrow(/over the spending cap/);
    expect(relayed).toHaveLength(2); // nothing went to the relayer
  });

  it("reads the cap window from the spend record, whatever else the policies hold under that key", async () => {
    await approveOnce("5");
    await open(2n, 1);
    const real = vi.mocked(rpc.Server.prototype.getLedgerEntries).getMockImplementation()!;
    vi.mocked(rpc.Server.prototype.getLedgerEntries).mockImplementation(async (...asked) => {
      const answer = await real(...asked);
      const other = map([["program", xdr.ScVal.scvU32(1)]]);
      return {
        ...answer,
        entries: [{ val: { contractData: () => ({ val: () => other }) } }, ...answer.entries],
      } as never;
    });
    expect(await grantStatus(ACCOUNT, pool)).toMatchObject({ state: "active", used: 20_000_000n, left: 30_000_000n });
  });

  it("reads only rules the document lists and the key signs", async () => {
    await approveOnce("5");
    const other = await generateSessionKey();
    keys.set(ACCOUNT, other);
    expect(await grantStatus(ACCOUNT, pool)).toEqual({ state: "none" });
  });
});
