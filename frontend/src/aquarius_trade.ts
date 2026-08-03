/**
 * T3.2 — in-app trading of vault receipt (share) tokens on Aquarius.
 *
 * The vault view's "exit without unwinding" path: quote a receipt-token swap
 * against the vault's underlying and execute it on the Aquarius router, without
 * sending the user to a third-party UI.
 *
 * Quotes come from the router's own `estimate_swap` view rather than the
 * find-path REST API. Both are correct, but `estimate_swap` reads the pool's
 * live reserves directly, so it works the moment a pool is created — find-path
 * only knows a pool once Aquarius' indexer has picked it up, which lags. Since
 * we create these pools ourselves, the on-chain read is the one that is never
 * stale. `aquarius.ts` (find-path) stays the source for cross-pool *rate
 * comparison*, where routing across unknown pools is the whole point.
 *
 * Router ABI (verified against the deployed contract on both networks):
 *   estimate_swap(tokens: Vec<Address>, token_in: Address, token_out: Address,
 *                 pool_index: BytesN<32>, in_amount: u128) -> u128
 *   swap_chained(user: Address,
 *                swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>,
 *                token_in: Address, in_amount: u128, out_min: u128) -> u128
 */

import {
  Account,
  Contract,
  TransactionBuilder,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { server as blendServer, getNetworkPassphrase } from "./blend.ts";
import { aquariusRouter } from "./aquarius.ts";
import type { AquariusListing } from "./aquarius_listings.ts";

/** Default slippage tolerance for receipt-token trades, in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%

// ── ScVal builders ───────────────────────────────────────────────────────────

const addr = (a: string) => nativeToScVal(a, { type: "address" });
const u128 = (v: bigint) => nativeToScVal(v, { type: "u128" });

/** `tokens` as the router expects it, in the order that created the pool. */
const tokensVec = (listing: AquariusListing) => xdr.ScVal.scvVec(listing.tokens.map(addr));

/**
 * Pool index as `BytesN<32>`. Aquarius surfaces it as 64 hex chars; anything
 * else means the listing entry is malformed and would fail deep inside the
 * router with an opaque error, so reject it here where the message is useful.
 */
export function parsePoolIndex(poolIndex: string): Buffer {
  const hex = poolIndex.startsWith("0x") ? poolIndex.slice(2) : poolIndex;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Invalid Aquarius pool index (expected 32-byte hex, got ${JSON.stringify(poolIndex)})`);
  }
  return Buffer.from(hex, "hex");
}

const poolIndexScVal = (poolIndex: string) => xdr.ScVal.scvBytes(parsePoolIndex(poolIndex));

/** The single-hop swap chain for a receipt↔underlying pool. */
function swapsChain(listing: AquariusListing, tokenOut: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    // One (tokens, pool_index, token_out) tuple — tuples are encoded as vecs.
    xdr.ScVal.scvVec([tokensVec(listing), poolIndexScVal(listing.poolIndex), addr(tokenOut)]),
  ]);
}

// ── Quote ────────────────────────────────────────────────────────────────────

export interface ReceiptSwapQuote {
  /** Expected output, in stroops of `tokenOut`. */
  amountOut: bigint;
  /** `amountOut` less the slippage tolerance — what we pass as `out_min`. */
  minOut: bigint;
  /**
   * How much worse the per-unit rate is at this size than at a 1-unit probe, in
   * basis points. Null when the reference probe is unavailable, so the UI can
   * omit the figure instead of implying zero impact.
   */
  impactBps: number | null;
}

/**
 * `out_min` for a quote: the most the price may move against the user before
 * the router reverts. Integer maths throughout — a float round-trip here would
 * quietly shift the on-chain limit.
 */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) throw new Error(`Slippage out of range: ${slippageBps} bps`);
  return (amountOut * BigInt(10_000 - Math.round(slippageBps))) / 10_000n;
}

/**
 * How much worse the per-unit rate is at size than at the reference probe, in
 * basis points. Clamped at zero: an AMM cannot give a genuinely better per-unit
 * rate for a larger trade, so small negatives are rounding, not an edge.
 * Returns null when either leg is unusable, so callers can omit the figure
 * rather than print a misleading zero.
 */
export function priceImpactBps(
  probeIn: bigint,
  probeOut: bigint,
  amountIn: bigint,
  amountOut: bigint,
): number | null {
  if (probeIn <= 0n || probeOut <= 0n || amountIn <= 0n || amountOut <= 0n) return null;
  const refRate = Number(probeOut) / Number(probeIn);
  const sizedRate = Number(amountOut) / Number(amountIn);
  if (!Number.isFinite(refRate) || refRate <= 0 || !Number.isFinite(sizedRate)) return null;
  return Math.max(0, ((refRate - sizedRate) / refRate) * 10_000);
}

async function simulateRead(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const account = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: getNetworkPassphrase() })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const detail = "error" in sim ? String((sim as { error: unknown }).error).slice(0, 200) : "unknown";
    throw new Error(`Aquarius ${method} failed: ${detail}`);
  }
  return sim.result!.retval;
}

/** Raw `estimate_swap` — output stroops for `amountIn` of `tokenIn`. */
export async function estimateReceiptSwap(
  listing: AquariusListing,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const retval = await simulateRead(aquariusRouter(), "estimate_swap", [
    tokensVec(listing),
    addr(tokenIn),
    addr(tokenOut),
    poolIndexScVal(listing.poolIndex),
    u128(amountIn),
  ]);
  return BigInt(scValToNative(retval) as string | number | bigint);
}

/**
 * Quote a receipt-token swap, with `out_min` already derived from
 * `slippageBps`. Throws if the pool cannot be read — callers render that as
 * "quote unavailable" rather than trading blind.
 */
export async function quoteReceiptSwap(
  listing: AquariusListing,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
): Promise<ReceiptSwapQuote> {
  const amountOut = await estimateReceiptSwap(listing, tokenIn, tokenOut, amountIn);
  const minOut = applySlippage(amountOut, slippageBps);

  // Reference probe at 1 unit to express the sized trade's price impact. Best
  // effort: a pool too thin to quote 1 unit still gets a tradeable headline
  // number, it just loses the impact figure.
  let impactBps: number | null = null;
  const probe = 10_000_000n;
  if (amountIn > probe) {
    try {
      const probeOut = await estimateReceiptSwap(listing, tokenIn, tokenOut, probe);
      impactBps = priceImpactBps(probe, probeOut, amountIn, amountOut);
    } catch {
      /* leave impactBps null — the headline quote is still tradeable */
    }
  } else {
    // The trade is no bigger than the reference probe: no impact to measure.
    impactBps = 0;
  }

  return { amountOut, minOut, impactBps };
}

// ── Execute ──────────────────────────────────────────────────────────────────

/**
 * Build a signed-ready `swap_chained` XDR. `minOut` is enforced on-chain by the
 * router, so a pool that moves between quote and submission reverts rather than
 * filling at a worse price.
 */
export async function buildAquariusSwapXdr(
  userAddress: string,
  listing: AquariusListing,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  minOut: bigint,
): Promise<string> {
  const account = await blendServer.getAccount(userAddress);
  const router = new Contract(aquariusRouter());

  const tx = new TransactionBuilder(account, {
    fee: "10000000", // 1 XLM budget — matches the vault tx builders in defindex.ts
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      router.call(
        "swap_chained",
        addr(userAddress),
        swapsChain(listing, tokenOut),
        addr(tokenIn),
        u128(amountIn),
        u128(minOut),
      ),
    )
    .setTimeout(300)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const detail = "error" in sim ? String((sim as { error: unknown }).error).slice(0, 300) : "unknown";
    throw new Error(`Swap simulation failed: ${detail}`);
  }

  // assembleTransaction folds in the auth entries the router needs to pull
  // `tokenIn` from the user via the SEP-41 transfer.
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}
