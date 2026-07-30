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

/**
 * Trade size, in units of the *output* asset (USDC), that the Compare view's
 * "Best Rate" badge measures price impact at.
 *
 * A fixed notional, not a fixed unit count: 1 unit of XLM and 1 unit of EURC are
 * ~$0.17 and ~$1.14 of trade, so ranking assets by their impact at "1 unit"
 * would compare wildly different trade sizes. It also has to be big enough to
 * actually move a pool — measured against mainnet, a 1-vs-10-unit probe returns
 * 0.0–5.6 bps of impact (noise, occasionally negative from rounding), while
 * $10k separates the assets cleanly and monotonically.
 */
export const IMPACT_NOTIONAL = 10_000;

export interface AquariusRateDepth {
  /** USDC per 1 unit, from the 1-unit reference probe. Null when unquotable. */
  rate: number | null;
  /**
   * How many basis points worse the per-unit rate gets when you trade
   * `notional` instead of 1 unit — i.e. the gap between the headline rate and
   * the rate you would actually receive at size. Lower is better; this is what
   * the "Best Rate" badge ranks on.
   *
   * Null when either probe has no route, so a pair that only quotes at 1 unit is
   * never badged on the strength of a rate nobody can trade.
   */
  impactBps: number | null;
  status: AquariusStatus;
}

/**
 * The two probes behind the "Best Rate" badge: a 1-unit reference rate (what the
 * DEX Rate column shows) and the same route at `notional` of size (what the
 * badge ranks on). Two calls, because Aquarius' response carries no depth or fee
 * information of its own — `amount_with_fee` comes back equal to `amount` on
 * every mainnet pair we quote, so it cannot stand in for this.
 *
 * Never throws, like the rest of this module. A failed second probe degrades to
 * `impactBps: null` while keeping the reference `rate`, so an unbadgeable row
 * still renders its rate.
 */
export async function aquariusRateWithImpact(
  tokenInId: string,
  tokenOutId: string,
  notional = IMPACT_NOTIONAL,
): Promise<AquariusRateDepth> {
  const probeStroops = 10_000_000n;
  const { price: rate, status } = await aquariusPriceResult(tokenInId, tokenOutId, probeStroops);
  if (rate == null || rate <= 0) return { rate: null, impactBps: null, status };

  // `notional` is denominated in the output asset, so units-in = notional / rate.
  const stroopsAtSize = BigInt(Math.round((notional / rate) * Number(probeStroops)));
  if (stroopsAtSize <= probeStroops) {
    // The sized trade is no bigger than the reference probe (a very expensive
    // input asset, or a tiny notional) — there is no impact to measure.
    return { rate, impactBps: 0, status: "ok" };
  }

  const sized = await aquariusPriceResult(tokenInId, tokenOutId, stroopsAtSize);
  if (sized.price == null || sized.price <= 0) return { rate, impactBps: null, status: sized.status };

  // Clamped at zero: a bigger trade cannot genuinely get a *better* per-unit
  // rate on an AMM, so the small negatives mainnet returns on deep stable pairs
  // are rounding, not an edge. Reporting them would rank noise.
  const impactBps = Math.max(0, ((rate - sized.price) / rate) * 10_000);
  return { rate, impactBps, status: "ok" };
}
