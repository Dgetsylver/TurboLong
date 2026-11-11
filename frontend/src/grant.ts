/**
 * Perch grants for TurboLong: what TurboLong asks a Nido account to allow, how
 * it reads back what the account installed, and how its session key signs a
 * call under it. Pure: no DOM, storage or network, so it is unit-tested alone.
 *
 * A grant is one app origin's rules on a Perch account: an `apply_grant` grant
 * on Perch dev (Nido's testnet preview, nidohq/nido#356), or rules in the
 * account's own policy document (`apply_doc`) on mainnet's Perch 0.5.1. The
 * owner approves it once on Nido's grant page with their passkey. Each rule
 * names one contract, the functions TurboLong's key may call there, and an
 * expiry; a rule on a token's `transfer` also pins the recipient (`to`) and
 * carries a rolling cap. The account enforces all of it in `__check_auth` for
 * every later call, and refuses what the rules do not allow (Perch dev:
 * `Error(Contract, #5)`; mainnet: OpenZeppelin's codes, `#3221` over the cap).
 *
 * TurboLong's grant has two rules per Blend pool:
 * - the pool's `submit` (no cap: `submit` moves no tokens itself);
 * - XLM `transfer`, paying only that pool, capped per window.
 * Blend's plain `submit` pulls the supplied XLM with `transfer(account, pool, n)`
 * inside the account's authorization, so the cap and the recipient pin apply to
 * every XLM the key moves into the pool. TurboLong's main-wallet flow uses
 * `approve` + `submit_with_allowance` instead, which Perch cannot cap (a capped
 * rule must allow exactly `transfer`) and Nido cannot pin.
 */
import { Address, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";

// ── Constants ─────────────────────────────────────────────────────────────────

export type GrantDuration = "24h" | "7d" | "30d";
export type CapPeriod = "day" | "week" | "30d";

/** Nido's ledger counts for each cap window (5 s ledgers). */
export const PERIOD_LEDGERS: Record<CapPeriod, number> = { day: 17_280, week: 120_960, "30d": 518_400 };
/** Nido turns a duration into ledgers at five seconds each. */
export const LEDGER_MS = 5_000;
/** How long a signed authorization stays valid: about five minutes. */
export const AUTH_LIFETIME_LEDGERS = 60;
/** Treat a rule as expired this many ledgers early, so a call never races its
 * last ledgers (about two minutes). */
export const EXPIRY_MARGIN_LEDGERS = 24;
const MAX_LABEL_BYTES = 20;
/** The most grants Nido's page takes in one request. */
const MAX_GRANTS = 8;
const STROOPS_PER_XLM = 10_000_000n;
/** Perch's domain tag for the address binding of the `addr_oz_v1` digest. */
const AUTH_ADDR_DOMAIN = "perch/account/auth-addr-v1";
const APP_SCOPE_DOMAIN = "nido/app-scope/v1";
const APP_SCOPE_CANDIDATES = 4;

// ── Byte helpers ──────────────────────────────────────────────────────────────

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("Invalid hex");
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
};

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(hash(Buffer.from(bytes)));

export const toBase64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const utf8 = (text: string) => new TextEncoder().encode(text);

// ── What TurboLong asks for ───────────────────────────────────────────────────

export interface GrantCap {
  /** Whole-XLM decimal, at most 7 fraction digits (Nido's `limit`). */
  xlm: string;
  period: CapPeriod;
}

/** One rule as Nido's grant page takes it (`grant.<i>.*`). */
export interface GrantAsk {
  label: string;
  target: string;
  functions: string[];
  /** `"none"`: declared uncapped (only for rules that move no tokens). */
  limit: GrantCap | "none";
  /** The only address `transfer` may pay. */
  to?: string;
}

/** A Blend pool as TurboLong's config names it. */
export interface GrantPool {
  id: string;
  name: string;
}

/** `name` cut to the account's rule-name limit, on a character boundary. */
function ruleName(name: string): string {
  const encoder = new TextEncoder();
  let out = "";
  for (const ch of name) {
    if (encoder.encode(out + ch).length > MAX_LABEL_BYTES) break;
    out += ch;
  }
  return out;
}

/** The rule names TurboLong uses for `pool`: the pool's own name, and `XLM`.
 * Nido replaces a rule of the same name, so the one `XLM` rule pays the pool
 * approved last: TurboLong is allowed in one pool at a time. */
export function grantLabels(pool: GrantPool): { submit: string; transfer: string } {
  return { submit: ruleName(pool.name), transfer: "XLM" };
}

/** The two rules TurboLong's key needs to open and close XLM positions in `pool`. */
export function turboLongGrant(pool: GrantPool, xlmToken: string, cap: GrantCap): GrantAsk[] {
  if (!StrKey.isValidContract(pool.id)) throw new Error(`Not a pool contract: ${pool.id}`);
  if (!StrKey.isValidContract(xlmToken)) throw new Error(`Not a token contract: ${xlmToken}`);
  xlmToStroops(cap.xlm);
  const labels = grantLabels(pool);
  return [
    { label: labels.submit, target: pool.id, functions: ["submit"], limit: "none" },
    { label: labels.transfer, target: xlmToken, functions: ["transfer"], limit: cap, to: pool.id },
  ];
}

/** Whole-XLM decimal → stroops. Refuses anything Nido would refuse. */
export function xlmToStroops(xlm: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(xlm.trim());
  if (!m) throw new Error(`Invalid XLM amount "${xlm}" (at most 7 decimals)`);
  const stroops = BigInt(m[1]!) * STROOPS_PER_XLM + BigInt((m[2] ?? "").padEnd(7, "0"));
  if (stroops <= 0n) throw new Error("A cap must be more than 0 XLM");
  return stroops;
}

export function stroopsToXlm(stroops: bigint, digits = 2): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = (stroops < 0n ? -stroops : stroops) % STROOPS_PER_XLM;
  const fracText = frac.toString().padStart(7, "0").slice(0, digits);
  return digits > 0 ? `${whole}.${fracText}` : whole.toString();
}

/**
 * Nido's grant page (`/security/delegate-doc/`) for `grants`, all for the P-256
 * key `publicKeyHex`. One request, one review, one owner passkey confirmation.
 * The page is on the account's own subdomain (`accountOrigin`).
 */
export function grantRequestUrl(args: {
  accountOrigin: string;
  account: string;
  publicKeyHex: string;
  origin: string;
  returnUrl: string;
  duration: GrantDuration;
  grants: GrantAsk[];
}): string {
  const { accountOrigin, account, publicKeyHex, origin, returnUrl, duration, grants } = args;
  if (!StrKey.isValidContract(account)) throw new Error(`Not a smart account: ${account}`);
  if (!/^04[0-9a-f]{128}$/.test(publicKeyHex)) throw new Error("The session key must be a 65-byte P-256 point (04…)");
  if (!grants.length) throw new Error("A grant needs at least one rule");
  if (grants.length > MAX_GRANTS) throw new Error(`Nido takes at most ${MAX_GRANTS} rules in one request`);
  if (new URL(returnUrl).origin !== new URL(origin).origin) throw new Error("The return URL must be on this origin");
  const url = new URL("/security/delegate-doc/", accountOrigin);
  const set = (key: string, value: string) => url.searchParams.set(key, value);
  set("origin", new URL(origin).origin);
  set("pubkey", publicKeyHex);
  set("duration", duration);
  const labels = new Set<string>();
  grants.forEach((g, i) => {
    if (utf8(g.label).length > MAX_LABEL_BYTES) throw new Error(`Rule label "${g.label}" is over 20 bytes`);
    if (labels.has(g.label)) throw new Error(`Two rules are labelled "${g.label}"`);
    labels.add(g.label);
    if (!StrKey.isValidContract(g.target)) throw new Error(`Rule "${g.label}" has no contract target`);
    if (!g.functions.length) throw new Error(`Rule "${g.label}" must list its functions`);
    const transfers = g.functions.includes("transfer");
    if (transfers && (g.functions.length > 1 || !g.to))
      throw new Error(`Rule "${g.label}" may call transfer, so it must allow only transfer and name its recipient`);
    if (g.to && !transfers) throw new Error(`Rule "${g.label}" names a recipient but does not call transfer`);
    if (transfers && g.limit === "none") throw new Error(`Rule "${g.label}" moves tokens, so it needs a cap`);
    const field = (name: string, value: string) => set(`grant.${i}.${name}`, value);
    field("label", g.label);
    field("target", g.target);
    field("functions", g.functions.join(","));
    if (g.limit === "none") field("limit", "none");
    else {
      xlmToStroops(g.limit.xlm);
      field("limit", g.limit.xlm);
      field("limit_period", g.limit.period);
    }
    if (g.to) field("to", g.to);
  });
  set("return", returnUrl);
  return url.toString();
}

/** Nido's answer to a grant request (`?delegation=ok|cancelled|error&code=`). */
export type GrantAnswer = { outcome: "approved" } | { outcome: "cancelled" } | { outcome: "error"; code: string };

export function parseGrantAnswer(search: string): GrantAnswer {
  const params = new URLSearchParams(search);
  const delegation = params.get("delegation");
  if (delegation === "ok") return { outcome: "approved" };
  if (delegation === "cancelled") return { outcome: "cancelled" };
  return { outcome: "error", code: params.get("code") ?? "Nido could not apply the grant and gave no reason." };
}

// ── What the account installed ────────────────────────────────────────────────

/** The grant ids Nido may keep `origin`'s rules under, in the order it tries
 * them: the big-endian u32 of `sha256("nido/app-scope/v1" ‖ 0 ‖ origin ‖ 0 ‖ i)`. */
export function appGrantCandidates(origin: string): number[] {
  const o = utf8(new URL(origin).origin);
  return Array.from({ length: APP_SCOPE_CANDIDATES }, (_, i) => {
    const digest = sha256(concat(utf8(APP_SCOPE_DOMAIN), Uint8Array.of(0), o, Uint8Array.of(0, i)));
    return new DataView(digest.buffer, digest.byteOffset).getUint32(0);
  });
}

/** Whether every signer id of a grant (`<origin>#<8 hex>`) is `origin`'s. */
export function grantBelongsTo(signerIds: readonly string[], origin: string): boolean {
  const o = new URL(origin).origin;
  return (
    signerIds.length > 0 &&
    signerIds.every((id) => id.startsWith(`${o}#`) && /^[0-9a-f]{8}$/.test(id.slice(o.length + 1)))
  );
}

export interface ExternalSigner {
  verifier: string;
  /** Key data, lowercase hex. */
  key: string;
}

export interface GrantCapRule {
  limit: bigint;
  periodLedgers: number;
  /** The argument the cap sums (2: SEP-41 transfer's amount). */
  amountArg: number;
}

/** One installed grant rule with what the account enforces for it. */
export interface GrantRule {
  id: number;
  name: string;
  contract: string | undefined;
  /** Allowed functions; `undefined` for any. */
  functions: string[] | undefined;
  /** The only address transfer's argument 1 may be. */
  to?: string;
  cap?: GrantCapRule;
  signers: ExternalSigner[];
  /** Last ledger the rule is valid in; `undefined` for no expiry. */
  validUntil: number | undefined;
  /** Policy contracts on the rule (mainnet's Perch 0.5.1: the interpreter
   * and, on a capped rule, the spending limit, which keeps the cap window). */
  policies?: string[];
}

/** A contract enum as `[tag, ...fields]` from either `scValToNative` shape. */
function variant(v: unknown): unknown[] | undefined {
  if (Array.isArray(v) && typeof v[0] === "string") return v;
  if (!v || typeof v !== "object") return undefined;
  const [tag, fields] = Object.entries(v)[0] ?? [];
  return tag === undefined ? undefined : [tag, ...(Array.isArray(fields) ? fields : [fields])];
}

const bytesHex = (v: unknown): string =>
  v instanceof Uint8Array
    ? toHex(v)
    : typeof v === "string"
      ? v.toLowerCase()
      : toHex(new Uint8Array(v as ArrayBuffer));

/** `grant(id).rules` and `grant_rule_set(id)` (aligned, `scValToNative` form)
 * as rules TurboLong can sign under. */
export function parseGrantRules(record: { rules: unknown[] }, ruleSet: unknown[]): GrantRule[] {
  return record.rules.map((raw, i) => {
    const rule = raw as {
      id: number;
      name: string;
      context_type: unknown;
      signers: unknown[];
      valid_until?: number | null;
    };
    const stored = (ruleSet[i] ?? {}) as {
      functions?: unknown;
      conds?: unknown[];
      cap?: { limit: bigint | string; period: number; amount_arg?: number }[];
    };
    const scope = variant(rule.context_type);
    const fns = variant(stored.functions);
    const listed = Array.isArray(fns?.[1]) ? (fns[1] as unknown[]).map(String) : [];
    // `AnyExcept([])` is every function; any other `AnyExcept` is read as
    // nothing callable, which only makes TurboLong ask again.
    const functions = fns?.[0] === "Only" ? listed : listed.length ? [] : undefined;
    const toCond = (stored.conds ?? []).map(variant).find((c) => c?.[0] === "ArgEq" && Number(c[1]) === 1);
    const toAddr = variant(toCond?.[2]);
    const cap = stored.cap?.[0];
    return {
      id: Number(rule.id),
      name: String(rule.name),
      contract: scope?.[0] === "CallContract" ? String(scope[1]) : undefined,
      functions,
      ...(toAddr?.[0] === "Address" ? { to: String(toAddr[1]) } : {}),
      ...(cap
        ? {
            cap: {
              limit: BigInt(cap.limit),
              periodLedgers: Number(cap.period),
              amountArg: cap.amount_arg === undefined ? 2 : Number(cap.amount_arg),
            },
          }
        : {}),
      signers: rule.signers
        .map(variant)
        .flatMap((s) => (s?.[0] === "External" ? [{ verifier: String(s[1]), key: bytesHex(s[2]) }] : [])),
      validUntil: rule.valid_until === null || rule.valid_until === undefined ? undefined : Number(rule.valid_until),
    };
  });
}

/** A rule of the account's applied policy document (`document()`), in the
 * parts TurboLong reads. */
interface DocRule {
  name: string;
  scope: { type: string; address?: string };
  functions?: string[];
  args?: { index: number; pred: { type: string; address?: string } }[];
  cap?: { limit: string; "period-ledgers": number };
}

/**
 * Mainnet's Perch 0.5.1 account keeps an app's rules in its own policy
 * document (Nido writes them with `apply_doc`; there is no `apply_grant`).
 * `installed_rules()` gives each rule's id, scope, signers, policies and
 * expiry; `document()` (canonical JSON) gives its functions, recipient pin and
 * cap. Both `scValToNative` / `JSON.parse` forms.
 */
export function parseDocRules(installed: unknown[], doc: { rules: DocRule[] } | undefined): GrantRule[] {
  return installed.map((raw) => {
    const rule = raw as {
      id: number;
      name: string;
      context_type: unknown;
      signers: unknown[];
      policies?: ({ policy: string } | string)[];
      valid_until?: number | null;
    };
    const scope = variant(rule.context_type);
    const contract = scope?.[0] === "CallContract" ? String(scope[1]) : undefined;
    const written = doc?.rules.find((r) => r.name === String(rule.name) && r.scope.address === contract);
    // SEP-41 transfer(from, to, amount): `to` is argument 1
    const to = written?.args?.find((a) => a.index === 1 && a.pred.type === "address-eq")?.pred.address;
    return {
      id: Number(rule.id),
      name: String(rule.name),
      contract,
      // A rule the document doesn't list is read as allowing nothing.
      functions: written ? written.functions : [],
      ...(to ? { to } : {}),
      ...(written?.cap
        ? { cap: { limit: BigInt(written.cap.limit), periodLedgers: written.cap["period-ledgers"], amountArg: 2 } }
        : {}),
      signers: rule.signers
        .map(variant)
        .flatMap((s) => (s?.[0] === "External" ? [{ verifier: String(s[1]), key: bytesHex(s[2]) }] : [])),
      validUntil: rule.valid_until === null || rule.valid_until === undefined ? undefined : Number(rule.valid_until),
      policies: (rule.policies ?? []).map((p) => (typeof p === "string" ? p : String(p.policy))),
    };
  });
}

const signedBy = (rule: GrantRule, publicKeyHex: string) => rule.signers.some((s) => s.key === publicKeyHex);

/** A rule is live at `ledger` while it has at least the expiry margin left. */
export const ruleLive = (rule: GrantRule, ledger: number): boolean =>
  rule.validUntil === undefined || rule.validUntil - EXPIRY_MARGIN_LEDGERS >= ledger;

/** What the UI shows about TurboLong's grant for one pool. */
export interface GrantView {
  submit: GrantRule;
  transfer: GrantRule;
  /** The earlier of the two rules' last ledgers. */
  validUntil: number | undefined;
  expired: boolean;
}

/** TurboLong's two rules for `pool` among `rules`, signed by its key. */
export function turboLongRules(
  rules: GrantRule[],
  pool: GrantPool,
  xlmToken: string,
  publicKeyHex: string,
  ledger: number,
): GrantView | undefined {
  const labels = grantLabels(pool);
  const mine = rules.filter((r) => signedBy(r, publicKeyHex));
  const submit = mine.find((r) => r.name === labels.submit && r.contract === pool.id);
  const transfer = mine.find((r) => r.name === labels.transfer && r.contract === xlmToken && r.to === pool.id);
  if (!submit || !transfer) return undefined;
  const ends = [submit.validUntil, transfer.validUntil].filter((v): v is number => v !== undefined);
  const validUntil = ends.length ? Math.min(...ends) : undefined;
  return { submit, transfer, validUntil, expired: !ruleLive(submit, ledger) || !ruleLive(transfer, ledger) };
}

/** When ledger `validUntil` arrives, in ms since the epoch, estimated from now. */
export function ledgerToTime(validUntil: number, latestLedger: number, now = Date.now()): number {
  return now + (validUntil - latestLedger) * LEDGER_MS;
}

// ── Spending cap ──────────────────────────────────────────────────────────────

/** A capped rule's window: the cap and the spends still counted. Perch dev
 * keeps them in the account (`SpendRecords(rule id)`: `{ history: [{ amount,
 * ledger }], total }`); mainnet's 0.5.1 in the spending-limit policy
 * (`AccountContext(account, rule id)`). */
export interface CapWindow {
  limit: bigint;
  periodLedgers: number;
  spent: { amount: bigint; ledger: number }[];
}

export function capWindow(cap: GrantCapRule, record: unknown): CapWindow {
  const r = (record ?? {}) as {
    history?: { amount: bigint | string; ledger: number }[];
    spending_limit?: bigint | string;
    period_ledgers?: number;
    spending_history?: { amount: bigint | string; ledger_sequence: number }[];
  };
  // Mainnet keeps the window in the spending-limit policy, with its own copy
  // of the cap: `{ spending_limit, period_ledgers, spending_history }`.
  if (r.spending_history)
    return {
      limit: r.spending_limit === undefined ? cap.limit : BigInt(r.spending_limit),
      periodLedgers: r.period_ledgers === undefined ? cap.periodLedgers : Number(r.period_ledgers),
      spent: r.spending_history.map((e) => ({ amount: BigInt(e.amount), ledger: Number(e.ledger_sequence) })),
    };
  return {
    limit: cap.limit,
    periodLedgers: cap.periodLedgers,
    spent: (r.history ?? []).map((e) => ({ amount: BigInt(e.amount), ledger: Number(e.ledger) })),
  };
}

/** Spends still inside the window at `ledger` (an entry stops counting
 * `periodLedgers` after its own ledger). */
const counting = (w: CapWindow, ledger: number) => w.spent.filter((e) => e.ledger > ledger - w.periodLedgers);

export function capUsed(w: CapWindow, ledger: number): bigint {
  return counting(w, ledger).reduce((sum, e) => sum + e.amount, 0n);
}

export function capLeft(w: CapWindow, ledger: number): bigint {
  const left = w.limit - capUsed(w, ledger);
  return left > 0n ? left : 0n;
}

// ── Signing under a grant ─────────────────────────────────────────────────────

/** One call an auth entry authorizes, as `__check_auth` sees it. */
export interface AuthContext {
  contract: string;
  fn: string;
  args: xdr.ScVal[];
}

/** The calls an auth entry authorizes, in the order the host passes them to
 * `__check_auth`: the root call, then its sub-calls depth first. */
export function authContexts(invocation: xdr.SorobanAuthorizedInvocation): AuthContext[] {
  const fn = invocation.function();
  const own: AuthContext =
    fn.switch().value === xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn().value
      ? {
          contract: Address.fromScAddress(fn.contractFn().contractAddress()).toString(),
          fn: fn.contractFn().functionName().toString(),
          args: fn.contractFn().args(),
        }
      : { contract: "create-contract", fn: "", args: [] };
  return [own, ...invocation.subInvocations().flatMap(authContexts)];
}

/** A call no live rule of TurboLong's key covers: the grant does not reach it. */
export class GrantScopeError extends Error {
  constructor(readonly context: AuthContext) {
    super(`TurboLong's grant does not cover ${context.fn} on ${context.contract}, or it expired.`);
    this.name = "GrantScopeError";
  }
}

/** For each context, the live rule of TurboLong's key that allows that call;
 * TurboLong's own labels win over any other rule on the same contract. */
export function ruleIdsFor(
  contexts: AuthContext[],
  rules: GrantRule[],
  publicKeyHex: string,
  ledger: number,
  preferred: string[] = [],
): number[] {
  return contexts.map((context) => {
    const fits = rules.filter(
      (r) =>
        r.contract === context.contract &&
        (r.functions === undefined || r.functions.includes(context.fn)) &&
        signedBy(r, publicKeyHex) &&
        ruleLive(r, ledger),
    );
    const rule = fits.find((r) => preferred.includes(r.name)) ?? fits[0];
    if (!rule) throw new GrantScopeError(context);
    return rule.id;
  });
}

/** The key's signer entries under `ruleIds`, exactly as installed. */
export function signersFor(ruleIds: number[], rules: GrantRule[], publicKeyHex: string): ExternalSigner[] {
  const found = new Map<string, ExternalSigner>();
  for (const rule of rules)
    if (ruleIds.includes(rule.id))
      for (const s of rule.signers) if (s.key === publicKeyHex) found.set(`${s.verifier}:${s.key}`, s);
  return [...found.values()];
}

/** The host's signature payload for an auth entry with these credentials. */
export function signaturePayload(
  networkPassphrase: string,
  nonce: xdr.Int64,
  expirationLedger: number,
  invocation: xdr.SorobanAuthorizedInvocation,
): Uint8Array {
  return sha256(
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(networkPassphrase)),
        nonce,
        signatureExpirationLedger: expirationLedger,
        invocation,
      }),
    ).toXDR(),
  );
}

/**
 * What the session key signs for one auth entry, as the account recomputes it
 * (`addr_oz_v1`): the payload bound to the account's address, then hashed with
 * the chosen rule ids, so it can't be replayed on another account or rules.
 */
export function authDigest(account: string, payload: Uint8Array, ruleIds: number[]): Uint8Array {
  const ids = xdr.ScVal.scvVec(ruleIds.map((id) => xdr.ScVal.scvU32(id))).toXDR();
  const bound = sha256(concat(utf8(AUTH_ADDR_DOMAIN), StrKey.decodeContract(account), payload));
  return sha256(concat(bound, ids));
}

/** A WebAuthn assertion as the account's verifier reads it. */
export interface WebAuthnAssertion {
  authenticatorData: Uint8Array;
  clientDataJson: Uint8Array;
  /** `r‖s`, 64 bytes, low-S. */
  signature: Uint8Array;
}

/** The XDR of OZ's `WebAuthnSigData`: a struct, so a map with sorted keys. */
export function webAuthnSigData(a: WebAuthnAssertion): Uint8Array {
  const field = (name: string, bytes: Uint8Array) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val: nativeToScVal(Buffer.from(bytes)) });
  return xdr.ScVal.scvMap([
    field("authenticator_data", a.authenticatorData),
    field("client_data", a.clientDataJson),
    field("signature", a.signature),
  ]).toXDR();
}

/** The `AuthPayload` a Perch account reads from its credential: the rule per
 * context, and the key's signature under each of its signer entries (a map,
 * sorted by verifier then key bytes). */
export function authPayload(ruleIds: number[], signers: ExternalSigner[], sigData: Uint8Array): xdr.ScVal {
  const order = (s: ExternalSigner) => `${toHex(StrKey.decodeContract(s.verifier))}:${s.key}`;
  const sorted = [...signers].sort((a, b) => (order(a) < order(b) ? -1 : 1));
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(ruleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap(
        sorted.map(
          (s) =>
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol("External"),
                new Address(s.verifier).toScVal(),
                nativeToScVal(Buffer.from(fromHex(s.key))),
              ]),
              val: nativeToScVal(Buffer.from(sigData)),
            }),
        ),
      ),
    }),
  ]);
}

// ── Refusals ──────────────────────────────────────────────────────────────────

export type RefusalKind = "refused" | "over-cap" | "stale" | "escalation" | "frozen";

const OVER_CAP = "Your account refused: this would go over the spending cap you gave TurboLong.";
const NO_RULE =
  "Your account refused: no rule in TurboLong's grant allows this call. It is outside the grant's scope, or the grant expired.";

/** OpenZeppelin smart-account and spending-limit codes (mainnet's Perch 0.5.1). */
const OZ_REFUSALS: Record<string, { kind: RefusalKind; text: string }> = {
  "3221": { kind: "over-cap", text: OVER_CAP },
  "3223": { kind: "refused", text: NO_RULE },
  "3000": { kind: "refused", text: NO_RULE },
  "3002": { kind: "refused", text: NO_RULE },
  "3003": { kind: "refused", text: "Your account refused: the session key's signature did not verify." },
  "3005": { kind: "refused", text: "Your account refused: TurboLong's grant expired. Approve it again." },
  "3014": { kind: "refused", text: NO_RULE },
  "3016": { kind: "refused", text: "Your account refused: the session key is not a signer of that rule." },
};

/** The account's refusal, from a simulation or submission error, in words.
 * OpenZeppelin codes (mainnet, Perch 0.5.1) first: #3221 over the cap,
 * #3000/#3002/#3014 no rule covers the call, #3005 expired, #3003/#3016 the
 * signer. Then Perch dev's `PerchAuthError`: 1 ReservedFunction, 2 AccountFrozen,
 * 3 StaleGrant, 4 GrantEscalation, 5 RuleEvalRefused (over a cap, no rule
 * covering the call, an expired rule, or a pinned argument that differs). */
export function accountRefusal(message: string): { kind: RefusalKind; text: string } | undefined {
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  if (code && OZ_REFUSALS[code]) return OZ_REFUSALS[code];
  if (!/__check_auth|Error\(Auth/.test(message)) return undefined;
  switch (code) {
    case "1":
      // Perch dev: ReservedFunction; mainnet's interpreter policy: Denied
      // (a function or argument check of the rule failed).
      return { kind: "refused", text: NO_RULE };
    case "5":
      return {
        kind: "refused",
        text: "Your account refused: no rule in TurboLong's grant allows this call. It is over the spending cap, outside the grant's scope, or the grant expired.",
      };
    case "3":
      return { kind: "stale", text: "Your account refused: a recovery ended TurboLong's grant. Approve it again." };
    case "4":
      return { kind: "escalation", text: "Your account refused: a grant may not make this kind of call." };
    case "2":
      return { kind: "frozen", text: "Your account is frozen while a recovery is pending." };
    default:
      return undefined;
  }
}
