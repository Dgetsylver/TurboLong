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
// NOTE: import the package's ESM entry by explicit subpath. The published
// `@stellar-broker/client@0.6.14` sets `main: lib/index.js` (which doesn't exist;
// the bundle is `lib/stellarbroker.js`) and only exposes the source via the
// bundler-only `module` field — so a bare specifier fails to resolve under Node.
import { estimateSwap, StellarBrokerClient } from "@stellar-broker/client/src/index.js";
import { StellarRouterContract } from "@creit-tech/stellar-router-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
const PASSPHRASE = Networks.PUBLIC;
const SLIPPAGE = Number(process.env.SLIPPAGE ?? "0.02");
const SOROSWAP_ROUTER = process.env.SOROSWAP_ROUTER ?? (StellarRouterContract.v1 as unknown as string);
const SWAP_ROUTES_URL = process.env.SWAP_ROUTES_URL;
const KEEPER_INGEST_KEY = process.env.KEEPER_INGEST_KEY;
const KEEPER_SECRET = process.env.KEEPER_SECRET;
const STELLAR_BROKER_PARTNER_KEY = process.env.STELLAR_BROKER_PARTNER_KEY ?? "";
const EXECUTE = process.argv.includes("--execute");
const QUOTE_AMOUNT_BLND = BigInt(process.env.QUOTE_AMOUNT_BLND ?? "1000000000"); // 100 BLND @ 7dp
// Confirm-to-settlement timeout for a live Broker session.
const BROKER_TIMEOUT_MS = Number(process.env.BROKER_TIMEOUT_MS ?? "120000");

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

// ── On-chain execution helpers ────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const addrScVal = (a: string) => Address.fromString(a).toScVal();
const i128ScVal = (n: bigint) => nativeToScVal(n, { type: "i128" });
const boolScVal = (b: boolean) => xdr.ScVal.scvBool(b);

/** Decode an i128 contract return value to a bigint (0 if absent/void). */
function scValToBigInt(v: xdr.ScVal | undefined): bigint {
  if (!v) return 0n;
  const n = scValToNative(v);
  return typeof n === "bigint" ? n : BigInt(Math.trunc(Number(n)));
}

interface InvokeResult {
  hash: string;
  returnValue: xdr.ScVal | undefined;
}

/**
 * Read-only simulation of a no-arg getter returning an Address (e.g.
 * `swap_account`). No signing, no submit. Returns the `G…`/`C…` string or null.
 */
async function simReadAddress(contractId: string, method: string): Promise<string | null> {
  try {
    const contract = new Contract(contractId);
    const acc = await server.getAccount(SIM_ACCOUNT).catch(() => null);
    if (!acc) return null;
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(contract.call(method))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return null;
    return String(scValToNative(sim.result.retval));
  } catch {
    return null;
  }
}

/**
 * Build → simulate/assemble → sign (keeper) → submit → poll a single Soroban
 * contract invocation. Single-signer, source-account auth (the keeper is the tx
 * source, so `prepareTransaction` resolves the require_auth() footprints). Throws
 * on submit error or a non-SUCCESS final status.
 */
async function invokeContract(
  keeper: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<InvokeResult> {
  const source = await server.getAccount(keeper.publicKey());
  const contract = new Contract(contractId);
  const built = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(built);
  prepared.sign(keeper);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${method} submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  let result = await server.getTransaction(sent.hash);
  const deadline = Date.now() + 60_000;
  while (result.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() < deadline) {
    await sleep(2000);
    result = await server.getTransaction(sent.hash);
  }
  if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${method} tx ${sent.hash} ended status=${result.status}`);
  }
  return { hash: sent.hash, returnValue: result.returnValue };
}

/**
 * Live Stellar Broker swap (keeper account). Opens a signed websocket session,
 * confirms the first successful streamed quote, and resolves with the realised
 * bought amount (stroops). The keeper Keypair authorizes each streamed leg.
 */
function brokerSwap(
  keeper: Keypair,
  sellingClassic: string,
  buyingClassic: string,
  sellingAmount: bigint,
  slippage: number,
): Promise<bigint> {
  return new Promise<bigint>((resolve, reject) => {
    const client = new StellarBrokerClient({
      partnerKey: STELLAR_BROKER_PARTNER_KEY,
      account: keeper.publicKey(),
      // Keeper secret authorizes each leg (AuthorizationWrapper signs with the Keypair).
      authorization: keeper.secret(),
    });
    let confirmed = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("broker session timeout"))), BROKER_TIMEOUT_MS);

    client.on("quote", (e: unknown) => {
      const q = (e as { detail: { status: string } }).detail;
      if (confirmed || q.status !== "success") return;
      confirmed = true;
      try {
        client.confirmQuote(keeper.publicKey());
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
    client.on("finished", (e: unknown) => {
      const r = (e as { detail: { bought: string } }).detail;
      finish(() => resolve(BigInt(Math.round(Number(r.bought ?? "0") * 1e7))));
    });
    client.on("error", (e: unknown) => {
      const msg = (e as { detail?: unknown }).detail;
      finish(() => reject(new Error(typeof msg === "string" ? msg : "broker session error")));
    });

    client
      .connect()
      .then(() =>
        client.quote({
          sellingAsset: sellingClassic,
          buyingAsset: buyingClassic,
          sellingAmount: (Number(sellingAmount) / 1e7).toString(),
          slippageTolerance: slippage,
        }),
      )
      .catch((err) => finish(() => reject(err instanceof Error ? err : new Error("broker connect failed"))));
  });
}

/**
 * Live harvest for one vault (keeper-operated, `--execute`):
 *   1. `harvest_claim(keeper)` — claim BLND into the strategy (+ approve the swap
 *      account to pull it for the off-chain route).
 *   2. Quote the *actually claimed* amount on both venues and pick the best.
 *   3. Broker: pull BLND → off-chain swap → return underlying → `harvest_reinvest`
 *      (via_soroswap=false). Soroswap: `harvest_reinvest` (via_soroswap=true) does
 *      the on-chain swap + re-leverage atomically.
 *   4. Log `status='executed'` with executed_out, slippage_bps, tx_hash.
 */
async function executeHarvest(v: Vault, keeper: Keypair): Promise<void> {
  const keeperPk = keeper.publicKey();

  // 1. Claim emissions into the strategy.
  const claimRes = await invokeContract(keeper, v.strategyId, "harvest_claim", [addrScVal(keeperPk)]);
  const claimed = scValToBigInt(claimRes.returnValue);
  console.log(`[${v.symbol}] claimed BLND=${claimed}`);
  if (claimed <= 0n) {
    await logRoute({
      network: "mainnet",
      strategy_id: v.strategyId,
      asset_symbol: v.symbol,
      amount_in: "0",
      broker_quote: null,
      soroswap_quote: null,
      chosen: "none",
      reason: "no_emissions",
      executed_out: "0",
      amount_out_min: "0",
      slippage_bps: null,
      uplift_bps: null,
      tx_hash: claimRes.hash,
      keeper: keeperPk,
      status: "executed",
    });
    return;
  }

  // 2. Quote the real claimed amount on both venues, then decide.
  const [broker, soroswap] = await Promise.all([
    v.underlyingClassic ? brokerQuote(BLND_CLASSIC, v.underlyingClassic, claimed) : Promise.resolve(null),
    soroswapQuote(claimed, [BLND_SOROBAN, v.underlyingSoroban]),
  ]);
  const d = decide(broker, soroswap);
  if (!d) throw new Error(`${v.symbol}: no executable quote for claimed ${claimed} BLND`);

  // 3. Execute the chosen route.
  let executedOut: bigint;
  let txHash: string;

  if (d.chosen === "broker") {
    if (!v.underlyingClassic) throw new Error(`${v.symbol}: broker chosen without a classic underlying`);
    // Fail fast (before pulling) if the on-chain swap_account — the holder of the
    // BLND allowance set by harvest_claim — isn't this keeper. Otherwise the
    // transfer_from below would revert; the just-claimed BLND stays safely in the
    // strategy and a later harvest can reinvest it on-chain via Soroswap.
    const onchainSwapAccount = await simReadAddress(v.strategyId, "swap_account");
    if (onchainSwapAccount && onchainSwapAccount !== keeperPk) {
      throw new Error(
        `${v.symbol}: on-chain swap_account ${onchainSwapAccount} != keeper ${keeperPk}; cannot pull BLND for the broker route`,
      );
    }
    // Pull the approved BLND from the strategy to the keeper account.
    await invokeContract(keeper, BLND_SOROBAN, "transfer_from", [
      addrScVal(keeperPk),
      addrScVal(v.strategyId),
      addrScVal(keeperPk),
      i128ScVal(claimed),
    ]);
    // Off-chain best-route swap BLND → underlying.
    const bought = await brokerSwap(keeper, BLND_CLASSIC, v.underlyingClassic, claimed, SLIPPAGE);
    if (bought < d.amountOutMin) {
      throw new Error(`${v.symbol}: broker out ${bought} below slippage floor ${d.amountOutMin}`);
    }
    // Return the underlying to the strategy, then re-leverage it directly.
    await invokeContract(keeper, v.underlyingSoroban, "transfer", [
      addrScVal(keeperPk),
      addrScVal(v.strategyId),
      i128ScVal(bought),
    ]);
    const r = await invokeContract(keeper, v.strategyId, "harvest_reinvest", [
      addrScVal(keeperPk),
      i128ScVal(bought),
      boolScVal(false),
      i128ScVal(0n),
    ]);
    executedOut = bought;
    txHash = r.hash;
  } else {
    // On-chain Soroswap swap + re-leverage, atomically inside the contract.
    const r = await invokeContract(keeper, v.strategyId, "harvest_reinvest", [
      addrScVal(keeperPk),
      i128ScVal(claimed),
      boolScVal(true),
      i128ScVal(d.amountOutMin),
    ]);
    executedOut = scValToBigInt(r.returnValue);
    txHash = r.hash;
  }

  // 4. Telemetry: realised slippage vs the chosen venue's quote.
  const chosenQuote = d.chosen === "broker" ? d.brokerQuote : d.soroswapQuote;
  const slippageBps =
    chosenQuote != null && chosenQuote > 0n && executedOut <= chosenQuote
      ? Number(((chosenQuote - executedOut) * 10000n) / chosenQuote)
      : 0;

  await logRoute({
    network: "mainnet",
    strategy_id: v.strategyId,
    asset_symbol: v.symbol,
    amount_in: claimed.toString(),
    broker_quote: d.brokerQuote?.toString() ?? null,
    soroswap_quote: d.soroswapQuote?.toString() ?? null,
    chosen: d.chosen,
    reason: d.reason,
    executed_out: executedOut.toString(),
    amount_out_min: d.amountOutMin.toString(),
    slippage_bps: slippageBps,
    uplift_bps: d.upliftBps,
    tx_hash: txHash,
    keeper: keeperPk,
    status: "executed",
  });
  console.log(`[${v.symbol}] executed via ${d.chosen}: out=${executedOut} tx=${txHash}`);
}

// ── Per-vault processing ─────────────────────────────────────────────────────

async function processVault(v: Vault, keeper: Keypair | null): Promise<void> {
  // Live settlement path (keeper-operated): claim, re-quote the real amount,
  // execute the best route, log status='executed'.
  if (EXECUTE && keeper && v.strategyId !== "QUOTE_ONLY") {
    await executeHarvest(v, keeper);
    return;
  }

  // Dry-run A/B data gathering: quote a nominal amount on both venues and log
  // status='quote_only' (no signing, no on-chain writes). QUOTE_ONLY vaults stay
  // here even under --execute (no real strategy id to settle against).
  const amountIn = QUOTE_AMOUNT_BLND;
  const [broker, soroswap] = await Promise.all([
    v.underlyingClassic ? brokerQuote(BLND_CLASSIC, v.underlyingClassic, amountIn) : Promise.resolve(null),
    soroswapQuote(amountIn, [BLND_SOROBAN, v.underlyingSoroban]),
  ]);

  const d = decide(broker, soroswap);
  if (!d) { console.warn(`[${v.symbol}] no quotes available`); return; }

  await logRoute({
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
    keeper: keeper ? keeper.publicKey() : null,
    status: "quote_only",
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`harvest_router — mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"} slippage=${SLIPPAGE} router=${SOROSWAP_ROUTER}`);
  let keeper: Keypair | null = null;
  if (EXECUTE) {
    if (!KEEPER_SECRET) {
      console.error("--execute requires KEEPER_SECRET");
      process.exit(1);
    }
    keeper = Keypair.fromSecret(KEEPER_SECRET);
    console.log(`keeper=${keeper.publicKey()} broker_partner=${STELLAR_BROKER_PARTNER_KEY ? "set" : "unset"}`);
  }
  for (const v of VAULTS) {
    try {
      await processVault(v, keeper);
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
