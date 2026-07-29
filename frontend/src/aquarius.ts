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
 * Why a quote is missing. Callers render these differently: `no_route` is a
 * property of the pair (Aquarius answered, there is just no path), while
 * `unreachable` means the API itself is down and the caller should say so
 * rather than implying the pair is untradeable. See
 * `docs/aquarius-rate-fallback.md`.
 */
export type AquariusStatus = "ok" | "no_route" | "unreachable";

export interface AquariusQuoteResult {
  quote: AquariusQuote | null;
  status: AquariusStatus;
}

/** `amount` comes back as a JSON number on live mainnet and as a string in
 *  some deployments — normalise both to stroops without going through float. */
function toStroops(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : BigInt(Math.round(v));
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

/**
 * Best-rate (strict-send) quote with an explicit reason when there is none.
 * Token addresses are Soroban contract IDs (SAC for classic assets).
 */
export async function aquariusBestRateResult(
  tokenInId: string,
  tokenOutId: string,
  amountInStroops: bigint,
): Promise<AquariusQuoteResult> {
  if (tokenInId === tokenOutId || amountInStroops <= 0n) return { quote: null, status: "no_route" };
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
    // 4xx = Aquarius answered and refused this pair; 5xx = the service is sick.
    if (!res.ok) return { quote: null, status: res.status >= 500 ? "unreachable" : "no_route" };
    const d = (await res.json()) as Record<string, unknown>;
    const amountOut = toStroops(d.amount);
    if (!d.success || amountOut == null) return { quote: null, status: "no_route" };
    return {
      quote: {
        amountOut,
        amountWithFee: toStroops(d.amount_with_fee) ?? amountOut,
        pools: (d.pools as string[]) ?? [],
        tokens: (d.tokens as string[]) ?? [],
        swapChainXdr: (d.swap_chain_xdr as string) ?? "",
      },
      status: "ok",
    };
  } catch {
    // Network error, DNS failure, CORS block or the 6s AbortSignal timeout.
    return { quote: null, status: "unreachable" };
  }
}

/**
 * Best-rate (strict-send) quote: how much `tokenOut` you get for `amountIn` of
 * `tokenIn`. Returns null when Aquarius is unreachable or has no feasible route
 * (caller falls back to its other source / hides the Aquarius figure). Use
 * `aquariusBestRateResult` when you need to tell those two cases apart.
 */
export async function aquariusBestRate(
  tokenInId: string,
  tokenOutId: string,
  amountInStroops: bigint,
): Promise<AquariusQuote | null> {
  return (await aquariusBestRateResult(tokenInId, tokenOutId, amountInStroops)).quote;
}

/**
 * Effective price of `tokenIn` in `tokenOut` from Aquarius (out per 1 in), with
 * the reason attached when there is no price. Quotes a 1-unit (1e7 stroops)
 * trade by default — adjust `probeStroops` for depth-sensitive pricing.
 */
export async function aquariusPriceResult(
  tokenInId: string,
  tokenOutId: string,
  probeStroops = 10_000_000n,
): Promise<{ price: number | null; status: AquariusStatus }> {
  const { quote, status } = await aquariusBestRateResult(tokenInId, tokenOutId, probeStroops);
  if (!quote) return { price: null, status };
  return { price: Number(quote.amountOut) / Number(probeStroops), status: "ok" };
}

/** Effective price of `tokenIn` in `tokenOut` from Aquarius (out per 1 in), or null. */
export async function aquariusPrice(
  tokenInId: string,
  tokenOutId: string,
  probeStroops = 10_000_000n,
): Promise<number | null> {
  return (await aquariusPriceResult(tokenInId, tokenOutId, probeStroops)).price;
}
