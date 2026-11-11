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
  getKnownPools,
  getPoolAssets,
  grantClosePlan,
  grantOpenPlan,
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
  };
});

const { GrantRefusedError, grantStatus, submitUnderGrant } = await import("../src/grant-session");

const ORIGIN = "http://localhost:5173";
const ACCOUNT = StrKey.encodeContract(Buffer.alloc(32, 7));
const VERIFIER = "CDPT2W5ZYRHKD7ESV4OXPKYBWCCCAZRKRDAI4EAE7ACXE5ZN76F23OZP";
const XLM = Asset.native().contractId(Networks.TESTNET);
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

setNetwork("testnet");
const pool = getKnownPools()[0];
const xlm = getPoolAssets(pool).find((a) => a.id === XLM)!;
const usdc = getPoolAssets(pool).find((a) => a.symbol === "USDC")!;

// ── The emulated account ──────────────────────────────────────────────────────

interface Installed extends GrantRule {
  key: string;
}

const chain = {
  ledger: 1_000,
  rules: [] as Installed[],
  spends: new Map<number, { amount: bigint; ledger: number }[]>(),
  sent: [] as string[],
  pendingCharges: [] as [number, bigint][],
  ownerPrompts: 0,
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

/** The account's view functions, as a simulation returns them. */
function view(fn: string, args: xdr.ScVal[]): xdr.ScVal {
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

const REFUSED = "HostError: Error(Contract, #5)\nEvent log: contract call failed: __check_auth";

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
  if (payload.context_rule_ids.length !== contexts.length) return REFUSED;
  const charges: [number, bigint][] = [];
  for (const [i, context] of contexts.entries()) {
    const rule = chain.rules.find((r) => r.id === payload.context_rule_ids[i]);
    if (!rule || rule.contract !== context.contract || !rule.functions!.includes(context.fn)) return REFUSED;
    if (rule.key !== key || chain.ledger > rule.validUntil!) return REFUSED;
    if (rule.to && Address.fromScVal(context.args[1]).toString() !== rule.to) return REFUSED;
    if (Address.fromScVal(context.args[0]).toString() !== ACCOUNT && context.fn === "transfer") return REFUSED;
    if (rule.cap) {
      const amount = BigInt(scValToNative(context.args[2]) as bigint);
      const window = (chain.spends.get(rule.id) ?? []).filter((e) => e.ledger > chain.ledger - rule.cap!.periodLedgers);
      const used = window.reduce((s, e) => s + e.amount, 0n);
      if (used + amount > rule.cap.limit) return REFUSED;
      charges.push([rule.id, amount]);
    }
  }
  // The WebAuthn verifier, on the digest the account recomputes.
  const digest = authDigest(
    ACCOUNT,
    signaturePayload(Networks.TESTNET, creds.nonce(), creds.signatureExpirationLedger(), entry.rootInvocation()),
    payload.context_rule_ids,
  );
  const sig = scValToNative(xdr.ScVal.fromXDR(sigBytes)) as Record<string, Uint8Array>;
  const client = JSON.parse(new TextDecoder().decode(sig.client_data));
  if (client.type !== "webauthn.get" || client.challenge !== toBase64url(digest)) return REFUSED;
  if ((sig.authenticator_data[32] & 0x05) !== 0x05) return REFUSED;
  if (BigInt(`0x${toHex(sig.signature.slice(32))}`) > P256_N / 2n) return REFUSED;
  const pub = await crypto.subtle.importKey("raw", fromHex(key), { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", sig.client_data));
  const message = new Uint8Array([...sig.authenticator_data, ...clientHash]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig.signature, message);
  return ok ? charges : REFUSED;
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

beforeEach(() => {
  Object.assign(chain, { ledger: 1_000, rules: [], spends: new Map(), sent: [], pendingCharges: [], ownerPrompts: 0 });
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
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation(async (key) => {
    const id = scValToNative(key.contractData().key()) as [string, number];
    const history = chain.spends.get(id[1]);
    if (!history) return { entries: [], latestLedger: chain.ledger } as never;
    const val = map([
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
      [
        "total",
        nativeToScVal(
          history.reduce((s, e) => s + e.amount, 0n),
          { type: "i128" },
        ),
      ],
    ]);
    return { entries: [{ val: { contractData: () => ({ val: () => val }) } }], latestLedger: chain.ledger } as never;
  });
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async (tx, _r, authMode) => {
    const op = (tx as Transaction).operations[0] as unknown as {
      func: xdr.HostFunction;
      auth?: xdr.SorobanAuthorizationEntry[];
    };
    const call = op.func.invokeContract();
    const contract = Address.fromScAddress(call.contractAddress()).toString();
    const fn = call.functionName().toString();
    if (contract === ACCOUNT) return success(view(fn, call.args()));
    if (contract !== pool.id || fn !== "submit") throw new Error(`unexpected call ${fn}`);
    if (authMode !== "enforce") return success(xdr.ScVal.scvVoid(), [submitAuth(call.args()[3])]);
    const verdict = await checkAuth(op.auth![0]);
    if (typeof verdict === "string")
      return { id: "sim", latestLedger: chain.ledger, error: verdict, events: [], _parsed: true } as never;
    chain.pendingCharges = verdict;
    return success(xdr.ScVal.scvVoid());
  });
  vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(async () => {
    const hash = (chain.sent.length + 1).toString(16).padStart(64, "0");
    for (const [id, amount] of chain.pendingCharges)
      chain.spends.set(id, [...(chain.spends.get(id) ?? []), { amount, ledger: chain.ledger }]);
    chain.sent.push(hash);
    chain.ledger += 10;
    return { status: "PENDING", hash } as never;
  });
  vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({ status: "SUCCESS" } as never);
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
      grants: turboLongGrant(pool.id, XLM, { xlm: cap, period: "day" }),
    }),
  );
}

const open = (xlmAmount: bigint, leverage: number, asset = xlm) =>
  submitUnderGrant({
    account: ACCOUNT,
    pool,
    requests: grantOpenPlan(asset, xlmAmount * 10_000_000n, leverage).requests,
  });

describe("grant mode demo (emulated Perch dev account)", () => {
  it("approve once, two actions in the cap without prompts, then the account refuses one over the cap", async () => {
    await approveOnce("40");
    expect(chain.ownerPrompts).toBe(1);
    const before = await grantStatus(ACCOUNT, pool);
    expect(before).toMatchObject({ state: "active", left: 400_000_000n, limit: 400_000_000n });

    // 1. Open 10 XLM at 2x: Blend pulls 20 XLM through the capped transfer.
    await open(10n, 2);
    // 2. Close it: repay ~10 XLM of debt (with margin), withdraw the collateral.
    const debt = { asset: xlm, dTokens: 100_000_000n, dRate: 1_000_000_000_000n } as AssetPosition;
    await submitUnderGrant({ account: ACCOUNT, pool, requests: grantClosePlan(debt).requests });
    expect(chain.sent).toHaveLength(2);
    expect(chain.ownerPrompts).toBe(1); // no passkey or wallet prompt for either
    const after = await grantStatus(ACCOUNT, pool);
    expect(after.state).toBe("active");
    if (after.state !== "active") return;
    expect(after.used).toBe(200_000_000n + grantClosePlan(debt).pull);
    expect(after.left).toBe(400_000_000n - after.used);

    // 3. Open 10 XLM at 2x again: 20 XLM more is over the 40 XLM/day cap.
    const refused = open(10n, 2);
    await expect(refused).rejects.toBeInstanceOf(GrantRefusedError);
    await expect(refused).rejects.toThrow(/over the spending cap/);
    expect(chain.sent).toHaveLength(2); // nothing was sent
    const unchanged = await grantStatus(ACCOUNT, pool);
    expect(unchanged.state === "active" && unchanged.used).toBe(after.used);
  });

  it("refuses an out-of-scope token before signing", async () => {
    await approveOnce();
    await expect(open(10n, 1.5, usdc)).rejects.toBeInstanceOf(GrantScopeError);
    expect(chain.sent).toHaveLength(0);
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
    expect(await grantStatus(ACCOUNT, pool)).toEqual({ state: "none", hasKey: false });
    await approveOnce();
    keys.clear();
    expect(await grantStatus(ACCOUNT, pool)).toEqual({ state: "none", hasKey: false });
    await expect(open(1n, 1.5)).rejects.toThrow(/approve TurboLong's grant first/);
  });
});
