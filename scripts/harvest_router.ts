/**
 * Turbolong harvest router (keeper) — SCF #43 Tranche-2 Deliverable 1.
 *
 * Per harvest, picks the best BLND→underlying swap route between **Stellar
 * Broker** (aggregated, off-chain RFQ) and **Soroswap** (on-chain AMM router),
 * enforces slippage on both, falls back to Soroswap when Broker is worse or
 * unavailable, and logs the A/B decision to the alerts Worker (`/swap-routes`)
 * plus a local JSONL evidence file.
 *
 * Modes:
 *   (default) DRY-RUN — real mainnet quotes, NO signing, NO on-chain writes.
 *             Logs `status='quote_only'` rows. Needs no key. This is the
 *             Cloudflare/CI-safe data-gathering mode.
 *   --execute  Live: claims BLND on-chain (`harvest_claim`), executes the chosen
 *             swap (Broker via a signed websocket session, or Soroswap
 *             on-chain via `harvest_reinvest(via_soroswap=true)`), re-leverages
 *             through the contract's split harvest, logs `status='executed'`.
 *             Requires KEEPER_SECRET and is meant for the dedicated Node
 *             keeper service (not a CI runner).
 *   --loop     Keep running: re-run every INTERVAL_S (default 3600s). Combine
 *             with --execute for the production harvest keeper service.
 *
 * Execution flow (per vault, --execute):
 *   1. `harvest_claim(keeper)` → BLND claimed into the strategy and approved to
 *      the swap account (which must be the keeper for the Broker path).
 *   2. Re-quote Broker + Soroswap with the actual claimed amount → `decide`.
 *   3a. Soroswap chosen → `harvest_reinvest(via_soroswap=true, amount_out_min)`.
 *   3b. Broker chosen → pull BLND to the keeper (SAC `transfer_from`), trade in
 *       a signed Broker session (slippageTolerance enforced by the Broker),
 *       transfer the bought underlying back to the strategy, then
 *       `harvest_reinvest(via_soroswap=false, amount_in=bought)`.
 *   4. Fallback: if the Broker trade fails or partially fills, any unsold BLND
 *      is returned to the strategy and reinvested via the on-chain Soroswap
 *      path (fresh min-out), so funds are never stranded on the keeper.
 *
 * Env:
 *   RPC_URL                 (default mainnet public RPC)
 *   SLIPPAGE                (fraction, default 0.02 = 2%)
 *   SOROSWAP_ROUTER         (default = router SDK v1 mainnet address)
 *   SWAP_ROUTES_URL         alerts Worker base URL (for POST /swap-routes)
 *   KEEPER_INGEST_KEY       bearer token for POST /swap-routes
 *   KEEPER_SECRET           S... keeper key (only for --execute)
 *   VAULTS_JSON             JSON array of {symbol, strategyId, underlyingClassic, underlyingSoroban}
 *   QUOTE_AMOUNT_BLND       nominal BLND amount (stroops) to quote in dry-run (default 100e7)
 *   HARVEST_MIN_BLND        min claimed BLND (stroops) to bother swapping (default 1e7 = 1 BLND)
 *   STELLAR_BROKER_PARTNER_KEY  Broker partner key for the trading session
 *   BROKER_TRADE_TIMEOUT_S  max seconds to wait for a Broker trade (default 180)
 *   INTERVAL_S              loop interval seconds (default 3600, with --loop)
 *   EVIDENCE_FILE           JSONL evidence output (default docs/evidence/harvest-router-log.jsonl)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rpc as SorobanRpc,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Keypair,
  xdr,
} from "@stellar/stellar-sdk";
// Deep import: the published package's `main` points at a non-existent
// lib/index.js (webpack emits lib/stellarbroker.js), so Node's ESM resolver
// fails on the bare specifier. `src/index.js` is the real ESM entry.
import { estimateSwap, StellarBrokerClient } from "@stellar-broker/client/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
const PASSPHRASE = Networks.PUBLIC;
const SLIPPAGE = Number(process.env.SLIPPAGE ?? "0.02");
// Soroswap mainnet router (same source as deploy_strategy_mainnet.ts). The
// Creit StellarRouterContract.v1 previously used here is a different contract
// that doesn't expose router_get_amounts_out → quotes silently nulled out.
const SOROSWAP_ROUTER = process.env.SOROSWAP_ROUTER ?? "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
const SWAP_ROUTES_URL = process.env.SWAP_ROUTES_URL;
const KEEPER_INGEST_KEY = process.env.KEEPER_INGEST_KEY;
const KEEPER_SECRET = process.env.KEEPER_SECRET;
const EXECUTE = process.argv.includes("--execute");
const LOOP = process.argv.includes("--loop");
const INTERVAL_S = Number(process.env.INTERVAL_S ?? "3600");
const QUOTE_AMOUNT_BLND = BigInt(process.env.QUOTE_AMOUNT_BLND ?? "1000000000"); // 100 BLND @ 7dp
const HARVEST_MIN_BLND = BigInt(process.env.HARVEST_MIN_BLND ?? "10000000"); // 1 BLND @ 7dp
const BROKER_PARTNER_KEY = process.env.STELLAR_BROKER_PARTNER_KEY;
const BROKER_TRADE_TIMEOUT_S = Number(process.env.BROKER_TRADE_TIMEOUT_S ?? "180");
const EVIDENCE_FILE = resolve(
  HERE,
  process.env.EVIDENCE_FILE ?? "../docs/evidence/harvest-router-log.jsonl",
);

const BLND_CLASSIC = "BLND-GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY";
const BLND_SOROBAN = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";

interface Vault {
  symbol: string;
  strategyId: string;            // the blend_leverage vault contract (post-D1)
  underlyingClassic: string | null; // Broker classic ID, or null if no classic issuer
  underlyingSoroban: string;     // Soroban (SAC) contract address
}

// Defaults cover the Broker-quotable underlyings; CETES/USTRY have no classic
// Broker issuer → Soroswap-only (broker_quote logged as null). Override via
// VAULTS_JSON with the real strategy IDs once the mainnet vaults are deployed.
const DEFAULT_VAULTS: Vault[] = [
  { symbol: "USDC", strategyId: "QUOTE_ONLY", underlyingClassic: "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", underlyingSoroban: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" },
  { symbol: "XLM", strategyId: "QUOTE_ONLY", underlyingClassic: "XLM", underlyingSoroban: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" },
  { symbol: "CETES", strategyId: "QUOTE_ONLY", underlyingClassic: null, underlyingSoroban: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV" },
  { symbol: "USTRY", strategyId: "QUOTE_ONLY", underlyingClassic: null, underlyingSoroban: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR" },
];

const VAULTS: Vault[] = process.env.VAULTS_JSON ? JSON.parse(process.env.VAULTS_JSON) : DEFAULT_VAULTS;

const server = new SorobanRpc.Server(RPC_URL);
const SIM_ACCOUNT = "GBHD3V2XKX6DXHYZDSHA2UYZTO4MKB2R6QNSCDT4XEKNGTLPXT7A36EA"; // read-only sim source

const keeper = (() => {
  if (!EXECUTE) return null;
  if (!KEEPER_SECRET) {
    console.error("--execute requires KEEPER_SECRET (provide via `op run` / secrets manager)");
    process.exit(1);
  }
  return Keypair.fromSecret(KEEPER_SECRET);
})();

// ── On-chain helpers ─────────────────────────────────────────────────────────

/** Simulate a read-only contract call (no signing). */
async function simCall(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
  const acc = await server.getAccount(SIM_ACCOUNT);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const err = SorobanRpc.Api.isSimulationError(sim) ? sim.error : "unknown simulation failure";
    throw new Error(`${method} simulation failed: ${err}`);
  }
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

interface InvokeResult {
  hash: string;
  status: "success" | "failed" | "timeout" | "send_error";
  result: unknown;
}

/** Sign + submit a contract invocation with the keeper key; poll for the result. */
async function invoke(kp: Keypair, contractId: string, method: string, ...args: xdr.ScVal[]): Promise<InvokeResult> {
  const acc = await server.getAccount(kp.publicKey());
  const built = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    return { hash: sent.hash, status: "send_error", result: sent.errorResult ?? null };
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash: sent.hash, status: "success", result: res.returnValue ? scValToNative(res.returnValue) : null };
    }
    if (res.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      return { hash: sent.hash, status: "failed", result: null };
    }
  }
  return { hash: sent.hash, status: "timeout", result: null };
}

/** SAC token balance of `holder` (works for classic & native via the SAC). */
async function sacBalance(token: string, holder: string): Promise<bigint> {
  const bal = (await simCall(token, "balance", new Address(holder).toScVal())) as bigint;
  return BigInt(bal);
}

const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });
const addr = (a: string) => new Address(a).toScVal();
const bool = (v: boolean) => nativeToScVal(v, { type: "bool" });

// ── Quotes ───────────────────────────────────────────────────────────────────

/** Soroswap router_get_amounts_out(amount_in, path) → final output (stroops). */
async function soroswapQuote(amountIn: bigint, path: string[]): Promise<bigint | null> {
  try {
    const router = new Contract(SOROSWAP_ROUTER);
    const pathVec = xdr.ScVal.scvVec(path.map((id) => new Contract(id).address().toScVal()));
    const op = router.call("router_get_amounts_out", i128(amountIn), pathVec);
    const acc = await server.getAccount(SIM_ACCOUNT).catch(() => null);
    if (!acc) return null;
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return null;
    const amounts = scValToNative(sim.result.retval) as bigint[];
    return BigInt(amounts[amounts.length - 1]);
  } catch (e) {
    console.warn(`[soroswap] quote failed: ${(e as Error).message}`);
    return null;
  }
}

/** Stellar Broker quote (aggregated). Returns the estimated buying amount. */
async function brokerQuote(sellingClassic: string, buyingClassic: string, amountIn: bigint): Promise<bigint | null> {
  try {
    const q = await estimateSwap({
      sellingAsset: sellingClassic,
      buyingAsset: buyingClassic,
      sellingAmount: (Number(amountIn) / 1e7).toString(),
      slippageTolerance: SLIPPAGE,
    });
    if (q.status !== "success" || !q.estimatedBuyingAmount) return null;
    return BigInt(Math.round(Number(q.estimatedBuyingAmount) * 1e7));
  } catch (e) {
    console.warn(`[broker] quote failed: ${(e as Error).message}`);
    return null;
  }
}

// ── Routing decision ─────────────────────────────────────────────────────────

type Route = "broker" | "soroswap";
interface Decision {
  chosen: Route;
  reason: "best" | "fallback_unavailable" | "fallback_worse";
  brokerQuote: bigint | null;
  soroswapQuote: bigint | null;
  upliftBps: number | null;
  amountOutMin: bigint;
}

function decide(broker: bigint | null, soroswap: bigint | null): Decision | null {
  if (broker == null && soroswap == null) return null;
  let chosen: Route;
  let reason: Decision["reason"];

  if (broker == null) { chosen = "soroswap"; reason = "fallback_unavailable"; }
  else if (soroswap == null) { chosen = "broker"; reason = "best"; }
  else if (broker > soroswap) { chosen = "broker"; reason = "best"; }
  else { chosen = "soroswap"; reason = soroswap > broker ? "fallback_worse" : "best"; }

  const chosenQ = chosen === "broker" ? broker! : soroswap!;
  const otherQ = chosen === "broker" ? soroswap : broker;
  const upliftBps = otherQ != null && otherQ > 0n
    ? Number(((chosenQ - otherQ) * 10000n) / otherQ)
    : null;
  // Slippage floor on the chosen quote.
  const amountOutMin = (chosenQ * BigInt(Math.round((1 - SLIPPAGE) * 10000))) / 10000n;
  return { chosen, reason, brokerQuote: broker, soroswapQuote: soroswap, upliftBps, amountOutMin };
}

// ── Telemetry ────────────────────────────────────────────────────────────────

async function logRoute(row: Record<string, unknown>): Promise<void> {
  const entry = { ts: new Date().toISOString(), ...row };
  console.log("[route]", JSON.stringify(entry));
  try {
    mkdirSync(dirname(EVIDENCE_FILE), { recursive: true });
    appendFileSync(EVIDENCE_FILE, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    console.warn(`[evidence] append failed: ${(e as Error).message}`);
  }
  if (!SWAP_ROUTES_URL || !KEEPER_INGEST_KEY) return;
  try {
    const res = await fetch(`${SWAP_ROUTES_URL}/swap-routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_INGEST_KEY}` },
      body: JSON.stringify(row),
    });
    if (!res.ok) console.warn(`[telemetry] POST failed: ${res.status}`);
  } catch (e) {
    console.warn(`[telemetry] POST error: ${(e as Error).message}`);
  }
}

/** Realized slippage vs. the winning quote, in bps (positive = worse than quoted). */
function slippageBps(quoted: bigint, executed: bigint): number | null {
  if (quoted <= 0n) return null;
  return Number(((quoted - executed) * 10000n) / quoted);
}

// ── Broker trade session ─────────────────────────────────────────────────────

interface BrokerTradeResult {
  ok: boolean;
  /** Bought amount reported by the Broker (stroops); on-chain deltas are the source of truth. */
  bought: bigint;
  error?: string;
}

/**
 * Run one Broker swap in a signed websocket session: quote → confirmQuote →
 * wait for `finished`. The Broker enforces `slippageTolerance` server-side;
 * quotes older than 10s are rejected by the client, so we confirm on the first
 * fresh quote event.
 */
function brokerTrade(kp: Keypair, sellingClassic: string, buyingClassic: string, amountIn: bigint): Promise<BrokerTradeResult> {
  return new Promise((resolvePromise) => {
    const client = new StellarBrokerClient({
      partnerKey: BROKER_PARTNER_KEY,
      account: kp.publicKey(),
      authorization: kp.secret(),
    });

    let settled = false;
    const finish = (r: BrokerTradeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch { /* already closed */ }
      resolvePromise(r);
    };
    const timer = setTimeout(() => {
      try { client.stop(); } catch { /* not trading */ }
      finish({ ok: false, bought: 0n, error: `trade timeout after ${BROKER_TRADE_TIMEOUT_S}s` });
    }, BROKER_TRADE_TIMEOUT_S * 1_000);

    let confirmed = false;
    client.on("quote", (e: any) => {
      if (confirmed) return;
      const q = e.quote ?? e.detail;
      if (q?.status !== "success") {
        finish({ ok: false, bought: 0n, error: `quote ${q?.status ?? "unavailable"}: ${q?.error ?? ""}` });
        return;
      }
      confirmed = true;
      try {
        client.confirmQuote(kp.publicKey(), kp.secret());
      } catch (err) {
        finish({ ok: false, bought: 0n, error: `confirmQuote failed: ${(err as Error).message}` });
      }
    });
    client.on("finished", (e: any) => {
      const r = e.result ?? e.detail;
      const bought = BigInt(Math.round(Number(r?.bought ?? "0") * 1e7));
      if (r?.status === "success") finish({ ok: true, bought });
      else finish({ ok: bought > 0n, bought, error: `trade finished with status ${r?.status}` });
    });
    client.on("error", (e: any) => {
      finish({ ok: false, bought: 0n, error: String(e.error ?? e.detail ?? "broker error") });
    });

    client.connect()
      .then(() => {
        client.quote({
          sellingAsset: sellingClassic,
          buyingAsset: buyingClassic,
          sellingAmount: (Number(amountIn) / 1e7).toFixed(7),
          slippageTolerance: SLIPPAGE,
        });
      })
      .catch(() => finish({ ok: false, bought: 0n, error: "broker connect failed" }));
  });
}

// ── Execution paths ──────────────────────────────────────────────────────────

/** Soroswap path: harvest_reinvest(via_soroswap=true) with mandatory min-out. */
async function executeSoroswap(v: Vault, kp: Keypair, amountIn: bigint, amountOutMin: bigint): Promise<InvokeResult> {
  return invoke(
    kp, v.strategyId, "harvest_reinvest",
    addr(kp.publicKey()), i128(amountIn), bool(true), i128(amountOutMin),
  );
}

interface BrokerExecutionOutcome {
  executedOut: bigint;     // underlying reinvested via the Broker path
  reinvestHash: string | null;
  unsoldBlnd: bigint;      // BLND returned to the strategy (fallback candidate)
  error?: string;
}

/**
 * Broker path: pull the approved BLND to the keeper, trade in a Broker session,
 * push the bought underlying back to the strategy and re-leverage it. On any
 * failure the unsold BLND is returned to the strategy so the on-chain Soroswap
 * fallback stays available. On-chain balance deltas (not the Broker's report)
 * decide the settled amounts.
 */
async function executeBroker(v: Vault, kp: Keypair, claimed: bigint): Promise<BrokerExecutionOutcome> {
  const me = kp.publicKey();
  const blndBefore = await sacBalance(BLND_SOROBAN, me);
  const underlyingBefore = await sacBalance(v.underlyingSoroban, me);

  // Pull the claimed BLND (strategy approved the swap account in harvest_claim).
  const pull = await invoke(
    kp, BLND_SOROBAN, "transfer_from",
    addr(me), addr(v.strategyId), addr(me), i128(claimed),
  );
  if (pull.status !== "success") {
    return { executedOut: 0n, reinvestHash: null, unsoldBlnd: claimed, error: `BLND pull ${pull.status}` };
  }

  const trade = await brokerTrade(kp, BLND_CLASSIC, v.underlyingClassic!, claimed);

  // Settle from on-chain deltas: covers partial fills and Broker-report drift.
  // (For the XLM vault the delta is net of session fees — conservative.)
  const blndAfter = await sacBalance(BLND_SOROBAN, me);
  const underlyingAfter = await sacBalance(v.underlyingSoroban, me);
  const bought = underlyingAfter > underlyingBefore ? underlyingAfter - underlyingBefore : 0n;
  let unsold = blndAfter > blndBefore ? blndAfter - blndBefore : 0n;
  if (unsold > claimed) unsold = claimed;

  // Return any unsold BLND to the strategy (keeps the Soroswap fallback whole).
  if (unsold > 0n) {
    const back = await invoke(kp, BLND_SOROBAN, "transfer", addr(me), addr(v.strategyId), i128(unsold));
    if (back.status !== "success") {
      console.error(`[${v.symbol}] CRITICAL: failed to return ${unsold} BLND to strategy (${back.status})`);
    }
  }

  if (bought === 0n) {
    return { executedOut: 0n, reinvestHash: null, unsoldBlnd: unsold, error: trade.error ?? "no output" };
  }

  // Push the proceeds to the strategy and re-leverage them.
  const push = await invoke(kp, v.underlyingSoroban, "transfer", addr(me), addr(v.strategyId), i128(bought));
  if (push.status !== "success") {
    return { executedOut: 0n, reinvestHash: null, unsoldBlnd: unsold, error: `underlying push ${push.status}` };
  }
  const reinvest = await invoke(
    kp, v.strategyId, "harvest_reinvest",
    addr(me), i128(bought), bool(false), i128(0n),
  );
  if (reinvest.status !== "success") {
    return { executedOut: 0n, reinvestHash: reinvest.hash, unsoldBlnd: unsold, error: `harvest_reinvest ${reinvest.status}` };
  }
  return { executedOut: bought, reinvestHash: reinvest.hash, unsoldBlnd: unsold, error: trade.error };
}

// ── Per-vault processing ─────────────────────────────────────────────────────

function baseRow(v: Vault, amountIn: bigint, d: Decision): Record<string, unknown> {
  return {
    network: "mainnet",
    strategy_id: v.strategyId,
    asset_symbol: v.symbol,
    amount_in: amountIn.toString(),
    broker_quote: d.brokerQuote?.toString() ?? null,
    soroswap_quote: d.soroswapQuote?.toString() ?? null,
    chosen: d.chosen,
    reason: d.reason,
    amount_out_min: d.amountOutMin.toString(),
    uplift_bps: d.upliftBps,
    keeper: keeper?.publicKey() ?? null,
  };
}

async function quoteBoth(v: Vault, amountIn: bigint): Promise<Decision | null> {
  const [broker, soroswap] = await Promise.all([
    v.underlyingClassic ? brokerQuote(BLND_CLASSIC, v.underlyingClassic, amountIn) : Promise.resolve(null),
    soroswapQuote(amountIn, [BLND_SOROBAN, v.underlyingSoroban]),
  ]);
  return decide(broker, soroswap);
}

async function processVault(v: Vault): Promise<void> {
  if (!EXECUTE || v.strategyId === "QUOTE_ONLY") {
    const d = await quoteBoth(v, QUOTE_AMOUNT_BLND);
    if (!d) { console.warn(`[${v.symbol}] no quotes available`); return; }
    await logRoute({ ...baseRow(v, QUOTE_AMOUNT_BLND, d), status: "quote_only" });
    return;
  }

  // ── Live execution ─────────────────────────────────────────────────────────
  const kp = keeper!;

  // The Broker path needs the keeper to be the strategy's swap account (it
  // pulls the approved BLND). If it isn't, quotes still log but only the
  // on-chain Soroswap path can execute.
  let brokerExecutable = !!v.underlyingClassic;
  if (brokerExecutable) {
    try {
      const swapAccount = (await simCall(v.strategyId, "swap_account")) as string;
      brokerExecutable = swapAccount === kp.publicKey();
      if (!brokerExecutable) console.warn(`[${v.symbol}] swap_account=${swapAccount} != keeper; Broker path disabled`);
    } catch {
      brokerExecutable = false;
      console.warn(`[${v.symbol}] swap_account unset; Broker path disabled`);
    }
  }

  // 1. Claim BLND emissions (also approves the swap account for the Broker pull).
  const claim = await invoke(kp, v.strategyId, "harvest_claim", addr(kp.publicKey()));
  if (claim.status !== "success") {
    console.error(`[${v.symbol}] harvest_claim ${claim.status} (tx ${claim.hash})`);
    return;
  }
  const claimed = BigInt(claim.result as bigint | number);
  if (claimed < HARVEST_MIN_BLND) {
    console.log(`[${v.symbol}] claimed ${claimed} BLND stroops < min ${HARVEST_MIN_BLND}; skipping swap`);
    return;
  }

  // 2. Re-quote with the actual claimed amount and pick the route.
  const d = await quoteBoth(v, claimed);
  if (!d) { console.warn(`[${v.symbol}] no quotes available post-claim`); return; }
  if (d.chosen === "broker" && !brokerExecutable) {
    d.chosen = "soroswap";
    d.reason = "fallback_unavailable";
    if (d.soroswapQuote == null) { console.warn(`[${v.symbol}] broker not executable and no Soroswap quote`); return; }
    d.amountOutMin = (d.soroswapQuote * BigInt(Math.round((1 - SLIPPAGE) * 10000))) / 10000n;
  }
  const base = baseRow(v, claimed, d);

  // 3. Execute the chosen route.
  if (d.chosen === "soroswap") {
    const res = await executeSoroswap(v, kp, claimed, d.amountOutMin);
    if (res.status !== "success") {
      await logRoute({ ...base, status: "failed", tx_hash: res.hash });
      return;
    }
    const realized = BigInt(res.result as bigint | number);
    await logRoute({
      ...base,
      status: "executed",
      executed_out: realized.toString(),
      slippage_bps: d.soroswapQuote != null ? slippageBps(d.soroswapQuote, realized) : null,
      tx_hash: res.hash,
    });
    return;
  }

  // Broker route.
  const out = await executeBroker(v, kp, claimed);
  if (out.executedOut > 0n) {
    const brokerFillIn = claimed - out.unsoldBlnd;
    await logRoute({
      ...base,
      amount_in: brokerFillIn.toString(),
      status: "executed",
      executed_out: out.executedOut.toString(),
      // Quote covered the full claim; scale it to the filled portion for a fair slippage figure.
      slippage_bps: d.brokerQuote != null && claimed > 0n
        ? slippageBps((d.brokerQuote * brokerFillIn) / claimed, out.executedOut)
        : null,
      tx_hash: out.reinvestHash,
    });
  }

  // 4. Fallback: reinvest any unsold BLND via the on-chain Soroswap path.
  if (out.unsoldBlnd > 0n) {
    console.warn(`[${v.symbol}] broker left ${out.unsoldBlnd} BLND unsold (${out.error ?? "partial fill"}); falling back to Soroswap`);
    const fbQuote = await soroswapQuote(out.unsoldBlnd, [BLND_SOROBAN, v.underlyingSoroban]);
    if (fbQuote == null) {
      await logRoute({ ...base, amount_in: out.unsoldBlnd.toString(), chosen: "soroswap", reason: "fallback_unavailable", status: "failed", tx_hash: null });
      console.error(`[${v.symbol}] fallback Soroswap quote unavailable; BLND stays in the strategy for the next pass`);
      return;
    }
    const fbMin = (fbQuote * BigInt(Math.round((1 - SLIPPAGE) * 10000))) / 10000n;
    const res = await executeSoroswap(v, kp, out.unsoldBlnd, fbMin);
    const realized = res.status === "success" ? BigInt(res.result as bigint | number) : null;
    await logRoute({
      ...base,
      amount_in: out.unsoldBlnd.toString(),
      chosen: "soroswap",
      reason: "fallback_unavailable",
      soroswap_quote: fbQuote.toString(),
      amount_out_min: fbMin.toString(),
      status: res.status === "success" ? "executed" : "failed",
      executed_out: realized?.toString() ?? null,
      slippage_bps: realized != null ? slippageBps(fbQuote, realized) : null,
      tx_hash: res.hash,
    });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function pass(): Promise<void> {
  for (const v of VAULTS) {
    try {
      await processVault(v);
    } catch (e) {
      console.error(`[${v.symbol}] failed:`, (e as Error).message);
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `harvest_router — mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"}${LOOP ? ` loop=${INTERVAL_S}s` : ""} slippage=${SLIPPAGE} router=${SOROSWAP_ROUTER}${keeper ? ` keeper=${keeper.publicKey()}` : ""}`,
  );
  await pass();
  while (LOOP) {
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1_000));
    await pass();
  }
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
