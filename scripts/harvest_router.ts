/**
 * Turbolong harvest router (keeper) — SCF #43 Tranche-2 Deliverable 1.
 *
 * Per harvest, picks the best BLND→underlying swap route between **Stellar
 * Broker** (aggregated, off-chain RFQ) and **Soroswap** (on-chain AMM router),
 * enforces slippage on both, falls back to Soroswap when Broker is worse or
 * unavailable, and logs the A/B decision to the alerts Worker (`/swap-routes`).
 *
 * Modes:
 *   (default) DRY-RUN — real mainnet quotes, NO signing, NO on-chain writes.
 *             Logs `status='quote_only'` rows. Needs no key. This is the
 *             Cloudflare/CI-safe data-gathering mode.
 *   --execute  Live: claims BLND on-chain, executes the chosen swap (Broker via
 *             a signed websocket session, or Soroswap on-chain), re-leverages
 *             via the contract's split harvest, logs `status='executed'`.
 *             Requires KEEPER_SECRET and is meant for the dedicated Node
 *             keeper service (not a CI runner).
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
 */
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
import { estimateSwap, StellarBrokerClient } from "@stellar-broker/client";
import { StellarRouterContract } from "@creit-tech/stellar-router-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
const PASSPHRASE = Networks.PUBLIC;
const SLIPPAGE = Number(process.env.SLIPPAGE ?? "0.02");
const SOROSWAP_ROUTER = process.env.SOROSWAP_ROUTER ?? (StellarRouterContract.v1 as unknown as string);
const SWAP_ROUTES_URL = process.env.SWAP_ROUTES_URL;
const KEEPER_INGEST_KEY = process.env.KEEPER_INGEST_KEY;
const KEEPER_SECRET = process.env.KEEPER_SECRET;
const EXECUTE = process.argv.includes("--execute");
const QUOTE_AMOUNT_BLND = BigInt(process.env.QUOTE_AMOUNT_BLND ?? "1000000000"); // 100 BLND @ 7dp

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

// ── Quotes ───────────────────────────────────────────────────────────────────

/** Soroswap router_get_amounts_out(amount_in, path) → final output (stroops). */
async function soroswapQuote(amountIn: bigint, path: string[]): Promise<bigint | null> {
  try {
    const router = new Contract(SOROSWAP_ROUTER);
    const pathVec = xdr.ScVal.scvVec(path.map((id) => new Contract(id).address().toScVal()));
    const op = router.call("router_get_amounts_out", nativeToScVal(amountIn, { type: "i128" }), pathVec);
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
  console.log("[route]", JSON.stringify(row));
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

// ── Per-vault processing ─────────────────────────────────────────────────────

async function processVault(v: Vault): Promise<void> {
  const amountIn = QUOTE_AMOUNT_BLND;
  const [broker, soroswap] = await Promise.all([
    v.underlyingClassic ? brokerQuote(BLND_CLASSIC, v.underlyingClassic, amountIn) : Promise.resolve(null),
    soroswapQuote(amountIn, [BLND_SOROBAN, v.underlyingSoroban]),
  ]);

  const d = decide(broker, soroswap);
  if (!d) { console.warn(`[${v.symbol}] no quotes available`); return; }

  const base: Record<string, unknown> = {
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
    keeper: KEEPER_SECRET ? Keypair.fromSecret(KEEPER_SECRET).publicKey() : null,
  };

  if (!EXECUTE || v.strategyId === "QUOTE_ONLY") {
    await logRoute({ ...base, status: "quote_only" });
    return;
  }

  // ── Execution path (dedicated Node keeper only) ──────────────────────────
  // 1. harvest_claim(keeper) on the strategy → BLND claimed + approved to the
  //    swap account.
  // 2. If chosen === 'broker': open a StellarBrokerClient session with the
  //    keeper Keypair, confirmQuote, receive underlying in the swap account,
  //    transfer it to the strategy, then harvest_reinvest(via_soroswap=false,
  //    amount_in=executed_out). If chosen === 'soroswap':
  //    harvest_reinvest(via_soroswap=true, amount_out_min).
  // 3. Log status='executed' with executed_out, slippage_bps, tx_hash.
  // Left as a guarded TODO: live signing + settlement is operated from the
  // dedicated keeper service with the key behind a secrets manager / remote
  // signer, not from this dry-run-first scaffold.
  console.warn(`[${v.symbol}] --execute requested but live settlement is operated from the keeper service; logging quote_only.`);
  await logRoute({ ...base, status: "quote_only" });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`harvest_router — mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"} slippage=${SLIPPAGE} router=${SOROSWAP_ROUTER}`);
  if (EXECUTE && !KEEPER_SECRET) {
    console.error("--execute requires KEEPER_SECRET");
    process.exit(1);
  }
  for (const v of VAULTS) {
    try {
      await processVault(v);
    } catch (e) {
      console.error(`[${v.symbol}] failed:`, (e as Error).message);
    }
  }
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
