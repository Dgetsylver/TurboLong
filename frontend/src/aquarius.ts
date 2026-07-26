/**
 * Aquarius (AQUA) AMM rate client — SCF T3.1.
 *
 * Aquarius exposes a public, auth-free REST API for best-route quotes across the
 * aggregated Stellar DEX surface. We use `POST /find-path/` (strict-send) to get
 * the best output for a pair; the on-chain router is the documented fallback.
 *
 * No npm SDK exists — plain HTTP + @stellar/stellar-sdk is the supported path.
 */

export const AQUARIUS_API =
  (import.meta.env.VITE_AQUARIUS_API as string | undefined) ?? "https://amm-api.aqua.network/api/external/v1";

/** Mainnet Aquarius router contract (on-chain fallback / execution). */
export const AQUARIUS_ROUTER = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK";

export interface AquariusQuote {
  /** Best output amount, in stroops (7-dp). */
  amountOut: bigint;
  /** Output net of pool fees, in stroops. */
  amountWithFee: bigint;
  /** Pool contract IDs along the chosen path. */
  pools: string[];
  /** Human-readable token names along the path. */
  tokens: string[];
  /** Base64 swap-chain XDR — hand straight to the router to execute. */
  swapChainXdr: string;
}

/**
 * Best-rate (strict-send) quote: how much `tokenOut` you get for `amountIn` of
 * `tokenIn`. Token addresses are Soroban contract IDs (SAC for classic assets).
 * Returns null when Aquarius is unreachable or has no feasible route (caller
 * falls back to its other source / hides the Aquarius figure).
 */
export async function aquariusBestRate(
  tokenInId: string,
  tokenOutId: string,
  amountInStroops: bigint,
): Promise<AquariusQuote | null> {
  if (tokenInId === tokenOutId || amountInStroops <= 0n) return null;
  try {
    const res = await fetch(`${AQUARIUS_API}/find-path/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: tokenInId,
        token_out_address: tokenOutId,
        amount: amountInStroops.toString(),
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    if (!d.success || d.amount == null) return null;
    return {
      amountOut: BigInt(d.amount as string),
      amountWithFee: BigInt((d.amount_with_fee as string) ?? (d.amount as string)),
      pools: (d.pools as string[]) ?? [],
      tokens: (d.tokens as string[]) ?? [],
      swapChainXdr: (d.swap_chain_xdr as string) ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Effective price of `tokenIn` in `tokenOut` from Aquarius (out per 1 in), or
 * null. Quotes a 1-unit (1e7 stroops) trade by default — adjust `probe` for
 * depth-sensitive pricing.
 */
export async function aquariusPrice(
  tokenInId: string,
  tokenOutId: string,
  probeStroops = 10_000_000n,
): Promise<number | null> {
  const q = await aquariusBestRate(tokenInId, tokenOutId, probeStroops);
  if (!q) return null;
  return Number(q.amountOut) / Number(probeStroops);
}
