import { describe, expect, it } from "vitest";
import { Address, Asset, Networks, StrKey, hash, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  EXPIRY_MARGIN_LEDGERS,
  GrantScopeError,
  PERIOD_LEDGERS,
  accountRefusal,
  appGrantCandidates,
  authContexts,
  authDigest,
  authPayload,
  capCharges,
  capFreesAt,
  capLeft,
  capUsed,
  capWindow,
  fromHex,
  grantBelongsTo,
  grantLabels,
  grantRequestUrl,
  parseGrantAnswer,
  parseGrantRules,
  ruleIdsFor,
  ruleLive,
  stroopsToXlm,
  toHex,
  turboLongGrant,
  turboLongRules,
  webAuthnSigData,
  xlmToStroops,
} from "../src/grant";
import { generateSessionKey, lowS, signAssertion } from "../src/grant-key";
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

const ACCOUNT = StrKey.encodeContract(Buffer.alloc(32, 7));
const POOL = "CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW";
const XLM = Asset.native().contractId(Networks.TESTNET);
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const VERIFIER = "CDPT2W5ZYRHKD7ESV4OXPKYBWCCCAZRKRDAI4EAE7ACXE5ZN76F23OZP";
const KEY = `04${"ab".repeat(64)}`;
const OTHER_KEY = `04${"cd".repeat(64)}`;
const ORIGIN = "http://localhost:5173";
const NIDO = `https://${ACCOUNT.toLowerCase()}.356.test.nido.fyi`;

/** `grant(id)` and `grant_rule_set(id)` as `scValToNative` gives them on the
 * Perch dev preview (shape read from a live testnet account). */
function liveGrant(opts: { key?: string; validUntil?: number; to?: string; limit?: bigint } = {}) {
  const { key = KEY, validUntil = 10_000, to = POOL, limit = 500_000_000n } = opts;
  const signers = [["External", VERIFIER, fromHex(key)]];
  const labels = grantLabels(POOL);
  return {
    record: {
      gen: 0n,
      doc_hash: new Uint8Array(32),
      rules: [
        { id: 1, name: labels.submit, context_type: ["CallContract", POOL], signers, valid_until: validUntil },
        { id: 2, name: labels.transfer, context_type: ["CallContract", XLM], signers, valid_until: validUntil },
      ],
    },
    ruleSet: [
      { auth_root: null, cap: [], conds: [], contract: POOL, functions: ["Only", ["submit"]], threshold: 1 },
      {
        auth_root: null,
        cap: [{ amount_arg: 2, limit, period: 17_280 }],
        conds: [
          ["ArgEq", 1, ["Address", to]],
          ["ArgI128AtMost", 2, 170141183460469231731687303715884105727n],
        ],
        contract: XLM,
        functions: ["Only", ["transfer"]],
        threshold: 1,
      },
    ],
  };
}

const rulesOf = (g = liveGrant()) => parseGrantRules(g.record, g.ruleSet);

function invocation(contract: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    subInvocations: subs,
  });
}

const addr = (a: string) => new Address(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const submitTree = (token = XLM, pull = 200_000_000n) =>
  invocation(
    POOL,
    "submit",
    [addr(ACCOUNT), addr(ACCOUNT), addr(ACCOUNT), xdr.ScVal.scvVec([])],
    [invocation(token, "transfer", [addr(ACCOUNT), addr(POOL), i128(pull)])],
  );

describe("what TurboLong asks for", () => {
  it("asks for submit on the pool and a capped XLM transfer paying only that pool", () => {
    const grants = turboLongGrant(POOL, XLM, { xlm: "50", period: "day" });
    expect(grants).toEqual([
      { label: "tl-submit-capbmx", target: POOL, functions: ["submit"], limit: "none" },
      {
        label: "tl-xlm-capbmx",
        target: XLM,
        functions: ["transfer"],
        limit: { xlm: "50", period: "day" },
        to: POOL,
      },
    ]);
    for (const g of grants) expect(new TextEncoder().encode(g.label).length).toBeLessThanOrEqual(20);
  });

  it("builds Nido's delegate-doc request with every grant field", () => {
    const url = new URL(
      grantRequestUrl({
        accountOrigin: NIDO,
        account: ACCOUNT,
        publicKeyHex: KEY,
        origin: ORIGIN,
        returnUrl: `${ORIGIN}/`,
        duration: "24h",
        grants: turboLongGrant(POOL, XLM, { xlm: "50", period: "day" }),
      }),
    );
    expect(url.origin).toBe(NIDO);
    expect(url.pathname).toBe("/security/delegate-doc/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      origin: ORIGIN,
      pubkey: KEY,
      duration: "24h",
      "grant.0.label": "tl-submit-capbmx",
      "grant.0.target": POOL,
      "grant.0.functions": "submit",
      "grant.0.limit": "none",
      "grant.1.label": "tl-xlm-capbmx",
      "grant.1.target": XLM,
      "grant.1.functions": "transfer",
      "grant.1.limit": "50",
      "grant.1.limit_period": "day",
      "grant.1.to": POOL,
      return: `${ORIGIN}/`,
    });
  });

  const base = {
    accountOrigin: NIDO,
    account: ACCOUNT,
    publicKeyHex: KEY,
    origin: ORIGIN,
    returnUrl: `${ORIGIN}/`,
    duration: "24h" as const,
  };
  const transfer = { label: "x", target: XLM, functions: ["transfer"], limit: { xlm: "1", period: "day" as const } };

  it.each([
    ["a transfer rule with no recipient", [transfer], /name its recipient/],
    [
      "transfer beside another function",
      [{ ...transfer, functions: ["transfer", "approve"], to: POOL }],
      /only transfer/,
    ],
    ["an uncapped transfer", [{ ...transfer, limit: "none" as const, to: POOL }], /needs a cap/],
    ["a recipient without transfer", [{ ...transfer, functions: ["submit"], to: POOL }], /does not call transfer/],
    ["a label over 20 bytes", [{ ...transfer, label: "x".repeat(21), to: POOL }], /over 20 bytes/],
    [
      "two rules with one label",
      [
        { ...transfer, to: POOL },
        { ...transfer, to: POOL },
      ],
      /Two rules/,
    ],
    [
      "a cap with 8 decimals",
      [{ ...transfer, to: POOL, limit: { xlm: "0.00000001", period: "day" as const } }],
      /7 decimals/,
    ],
    ["no rules", [], /at least one/],
  ])("refuses %s", (_, grants, error) => {
    expect(() => grantRequestUrl({ ...base, grants })).toThrow(error);
  });

  it("refuses a classic account, a malformed key and a return URL on another origin", () => {
    const grants = turboLongGrant(POOL, XLM, { xlm: "5", period: "week" });
    const classic = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
    expect(() => grantRequestUrl({ ...base, grants, account: classic })).toThrow(/smart account/);
    expect(() => grantRequestUrl({ ...base, grants, publicKeyHex: "04ab" })).toThrow(/P-256/);
    expect(() => grantRequestUrl({ ...base, grants, returnUrl: "https://evil.example/" })).toThrow(/this origin/);
  });

  it("converts XLM caps exactly", () => {
    expect(xlmToStroops("50")).toBe(500_000_000n);
    expect(xlmToStroops("0.1234567")).toBe(1_234_567n);
    expect(() => xlmToStroops("0")).toThrow(/more than 0/);
    expect(() => xlmToStroops("-1")).toThrow();
    expect(stroopsToXlm(205_000_000n)).toBe("20.50");
  });

  it("reads Nido's answer", () => {
    expect(parseGrantAnswer("?delegation=ok")).toEqual({ outcome: "approved" });
    expect(parseGrantAnswer("?delegation=cancelled")).toEqual({ outcome: "cancelled" });
    expect(parseGrantAnswer("?delegation=error&code=FEE_LIMIT_EXCEEDED")).toEqual({
      outcome: "error",
      code: "FEE_LIMIT_EXCEEDED",
    });
  });
});

describe("what the account installed", () => {
  it("derives Nido's grant ids for an origin and recognises its signer ids", () => {
    const ids = appGrantCandidates(ORIGIN);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(appGrantCandidates(`${ORIGIN}/trade?x=1`)).toEqual(ids);
    expect(grantBelongsTo([`${ORIGIN}#7e97b72a`], ORIGIN)).toBe(true);
    expect(grantBelongsTo([`${ORIGIN}#7e97b72a`, "https://other.example#00000000"], ORIGIN)).toBe(false);
    expect(grantBelongsTo([], ORIGIN)).toBe(false);
  });

  it("parses the live grant shape: functions, recipient pin, cap and expiry", () => {
    const [submit, transfer] = rulesOf();
    expect(submit).toMatchObject({ id: 1, contract: POOL, functions: ["submit"], validUntil: 10_000 });
    expect(submit.cap).toBeUndefined();
    expect(transfer).toMatchObject({
      id: 2,
      contract: XLM,
      functions: ["transfer"],
      to: POOL,
      cap: { limit: 500_000_000n, periodLedgers: 17_280, amountArg: 2 },
    });
    expect(transfer.signers).toEqual([{ verifier: VERIFIER, key: KEY }]);
  });

  it("finds TurboLong's two rules only for its own key and pinned recipient", () => {
    expect(turboLongRules(rulesOf(), POOL, XLM, KEY, 100)).toMatchObject({ validUntil: 10_000, expired: false });
    expect(turboLongRules(rulesOf(), POOL, XLM, OTHER_KEY, 100)).toBeUndefined();
    expect(turboLongRules(rulesOf(liveGrant({ to: USDC })), POOL, XLM, KEY, 100)).toBeUndefined();
  });

  it("treats a rule as expired a margin before its last ledger", () => {
    const [rule] = rulesOf();
    expect(ruleLive(rule, 10_000 - EXPIRY_MARGIN_LEDGERS)).toBe(true);
    expect(ruleLive(rule, 10_000 - EXPIRY_MARGIN_LEDGERS + 1)).toBe(false);
    expect(turboLongRules(rulesOf(), POOL, XLM, KEY, 9_990)?.expired).toBe(true);
  });
});

describe("spending cap", () => {
  const cap = { limit: 500_000_000n, periodLedgers: PERIOD_LEDGERS.day, amountArg: 2 };

  it("reads the account's SpendRecords and counts only the current window", () => {
    const w = capWindow(cap, {
      history: [
        { amount: 100_000_000n, ledger: 1_000 },
        { amount: 200_000_000n, ledger: 20_000 },
      ],
      total: 300_000_000n,
    });
    expect(capUsed(w, 20_100)).toBe(200_000_000n); // the first spend aged out at 18_280
    expect(capLeft(w, 20_100)).toBe(300_000_000n);
    expect(capLeft(capWindow(cap, undefined), 1)).toBe(500_000_000n);
  });

  it("lets two 20 XLM opens through a 50 XLM/day cap and holds the third until the window frees", () => {
    let w = capWindow(cap, undefined);
    const open = 200_000_000n; // 10 XLM at 2x: gross pull 20 XLM
    for (const ledger of [100, 200]) {
      expect(capFreesAt(w, open, ledger)).toBe(ledger);
      w = { ...w, spent: [...w.spent, { amount: open, ledger }] };
    }
    expect(capLeft(w, 300)).toBe(100_000_000n);
    expect(capFreesAt(w, open, 300)).toBe(100 + PERIOD_LEDGERS.day);
    expect(capFreesAt(w, 600_000_000n, 300)).toBeUndefined();
  });

  it("charges the capped rule with the transfer amount of each context", () => {
    const rules = rulesOf();
    const contexts = authContexts(submitTree(XLM, 123n));
    expect(capCharges(contexts, [1, 2], rules)).toEqual(new Map([[2, 123n]]));
  });
});

describe("signing under the grant", () => {
  it("lists the account's contexts root first and picks a rule per context", () => {
    const contexts = authContexts(submitTree());
    expect(contexts.map((c) => `${c.fn}@${c.contract.slice(0, 4)}`)).toEqual(["submit@CAPB", "transfer@CDLZ"]);
    expect(ruleIdsFor(contexts, rulesOf(), KEY, 100)).toEqual([1, 2]);
  });

  it("refuses to sign what the grant does not cover: another token, another key, or an expired rule", () => {
    expect(() => ruleIdsFor(authContexts(submitTree(USDC)), rulesOf(), KEY, 100)).toThrow(GrantScopeError);
    expect(() => ruleIdsFor(authContexts(submitTree()), rulesOf(), OTHER_KEY, 100)).toThrow(GrantScopeError);
    expect(() => ruleIdsFor(authContexts(submitTree()), rulesOf(), KEY, 9_990)).toThrow(/expired/);
  });

  it("prefers TurboLong's own rule over another app rule on the same contract", () => {
    const g = liveGrant();
    g.record.rules.unshift({
      id: 9,
      name: "other",
      context_type: ["CallContract", POOL],
      signers: g.record.rules[0].signers,
      valid_until: 10_000,
    });
    g.ruleSet.unshift({ ...g.ruleSet[0] });
    const contexts = authContexts(submitTree());
    expect(
      ruleIdsFor(contexts, parseGrantRules(g.record, g.ruleSet), KEY, 100, Object.values(grantLabels(POOL))),
    ).toEqual([1, 2]);
  });

  it("binds the digest to the account and the chosen rule ids (addr_oz_v1)", () => {
    const payload = new Uint8Array(32).fill(9);
    const ids = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)]).toXDR();
    const bound = hash(
      Buffer.concat([Buffer.from("perch/account/auth-addr-v1"), StrKey.decodeContract(ACCOUNT), Buffer.from(payload)]),
    );
    const expected = hash(Buffer.concat([bound, ids]));
    expect(toHex(authDigest(ACCOUNT, payload, [1, 2]))).toBe(expected.toString("hex"));
    expect(toHex(authDigest(ACCOUNT, payload, [2, 1]))).not.toBe(expected.toString("hex"));
  });

  it("encodes the AuthPayload the account reads", () => {
    const sig = webAuthnSigData({
      authenticatorData: new Uint8Array(37),
      clientDataJson: new TextEncoder().encode("{}"),
      signature: new Uint8Array(64),
    });
    const native = scValToNative(authPayload([1, 2], [{ verifier: VERIFIER, key: KEY }], sig)) as {
      context_rule_ids: number[];
      signers: Map<unknown, unknown> | Record<string, unknown>;
    };
    expect(native.context_rule_ids).toEqual([1, 2]);
    const decoded = scValToNative(xdr.ScVal.fromXDR(Buffer.from(sig))) as Record<string, Uint8Array>;
    expect(Object.keys(decoded)).toEqual(["authenticator_data", "client_data", "signature"]);
  });

  it("explains the account's refusals and ignores other errors", () => {
    const refusal = "HostError: Error(Contract, #5)\n... contract call failed __check_auth ...";
    expect(accountRefusal(refusal)?.kind).toBe("refused");
    expect(accountRefusal("HostError: Error(Contract, #3) in __check_auth")?.kind).toBe("stale");
    expect(accountRefusal("HostError: Error(Contract, #1205)")).toBeUndefined();
  });
});

describe("the session key", () => {
  it("is a non-extractable P-256 key with a 65-byte public point", async () => {
    const key = await generateSessionKey();
    expect(key.publicKeyHex).toMatch(/^04[0-9a-f]{128}$/);
    expect(key.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", key.privateKey)).rejects.toThrow();
  });

  it("signs an assertion the account's WebAuthn verifier accepts", async () => {
    const key = await generateSessionKey();
    const challenge = new Uint8Array(32).fill(3);
    const a = await signAssertion(key, challenge, ORIGIN);
    const client = JSON.parse(new TextDecoder().decode(a.clientDataJson));
    expect(client.type).toBe("webauthn.get");
    expect(Buffer.from(client.challenge, "base64url")).toEqual(Buffer.from(challenge));
    expect(a.authenticatorData).toHaveLength(37);
    expect(a.authenticatorData[32] & 0x05).toBe(0x05); // user present + user verified
    expect(a.authenticatorData[32] & 0x18).toBe(0); // no backup flags
    const s = BigInt(`0x${toHex(a.signature.slice(32))}`);
    expect(s <= 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n / 2n).toBe(true);
    const pub = await crypto.subtle.importKey(
      "raw",
      fromHex(key.publicKeyHex),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const clientHash = new Uint8Array(hash(Buffer.from(a.clientDataJson)));
    const message = new Uint8Array([...a.authenticatorData, ...clientHash]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, a.signature, message)).toBe(true);
  });

  it("flips a high-S signature into the lower half and leaves a low one alone", () => {
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const high = fromHex(`${"11".repeat(32)}${(n - 5n).toString(16).padStart(64, "0")}`);
    expect(toHex(lowS(high))).toBe(`${"11".repeat(32)}${5n.toString(16).padStart(64, "0")}`);
    const low = fromHex(`${"11".repeat(32)}${"00".repeat(31)}07`);
    expect(lowS(low)).toBe(low);
  });
});

describe("grant-mode Blend plans", () => {
  setNetwork("testnet");
  const pool = getKnownPools()[0];
  const xlm = getPoolAssets(pool).find((a) => a.id === XLM)!;
  const types = (requests: xdr.ScVal) =>
    (scValToNative(requests) as { request_type: number; amount: bigint }[]).map((r) => [
      r.request_type,
      BigInt(r.amount),
    ]);

  it("opens with the usual loop and pulls the gross supply", () => {
    const plan = grantOpenPlan(xlm, 100_000_000n, 2);
    const legs = types(plan.requests);
    expect(legs[0]).toEqual([2, 100_000_000n]); // supply collateral first
    const supplied = legs.filter(([t]) => t === 2).reduce((s, [, a]) => s + (a as bigint), 0n);
    const borrowed = legs.filter(([t]) => t === 4).reduce((s, [, a]) => s + (a as bigint), 0n);
    expect(borrowed).toBe(100_000_000n);
    expect(plan.pull).toBe(supplied);
    expect(plan.pull).toBe(200_000_000n);
  });

  it("closes with a fixed repay over the debt, then withdraws everything", () => {
    const pos = { asset: xlm, dTokens: 99_000_000n, dRate: 1_010_000_000_000n } as AssetPosition;
    const debt = debtStroops(pos);
    expect(debt).toBe(99_990_000n);
    const plan = grantClosePlan(pos);
    expect(plan.pull).toBe(repayWithMargin(debt));
    expect(plan.pull).toBeGreaterThan(debt);
    expect(types(plan.requests)).toEqual([
      [5, plan.pull],
      [3, 9_223_372_036_854_775_807n],
    ]);
    expect(grantClosePlan({ ...pos, dTokens: 0n }).pull).toBe(0n);
  });
});

describe("Nido account origins", () => {
  it("puts preview accounts one subdomain level under the apex, like Nido's current module", async () => {
    const { nidoAccountOrigin } = await import("../src/nido");
    const acc = ACCOUNT.toLowerCase();
    expect(nidoAccountOrigin("https://356.test.nido.fyi", ACCOUNT)).toBe(`https://${acc}--356.test.nido.fyi`);
    expect(nidoAccountOrigin("https://pr-356.test.nido.fyi", ACCOUNT)).toBe(`https://${acc}--356.test.nido.fyi`);
    expect(nidoAccountOrigin("https://nido.fyi", ACCOUNT)).toBe(`https://${acc}.nido.fyi`);
    expect(nidoAccountOrigin("http://localhost:4321", ACCOUNT)).toBe(`http://${acc}.localhost:4321`);
    expect(nidoAccountOrigin("http://127.0.0.1:4321", ACCOUNT)).toBe(`http://${acc}.127.0.0.1:4321`);
    expect(() => nidoAccountOrigin("https://nido.fyi", StrKey.encodeEd25519PublicKey(Buffer.alloc(32)))).toThrow();
  });
});
