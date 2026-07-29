/**
 * Aquarius (AQUA) AMM rate client — worker side, SCF T3.1.
 *
 * Mirrors `frontend/src/aquarius.ts` but standalone: the worker and the
 * frontend are separate builds with no shared module, and this copy stays
 * deliberately minimal (one call, no XDR, no execution path). Keep the request
 * shape in sync with the frontend client if the Aquarius API changes.
 *
 * The cron snapshots one rate per asset per tick so the Compare view can draw
 * 24h/7d DEX-rate trends from history instead of a single live probe.
 */

export const AQUARIUS_API = "https://amm-api.aqua.network/api/external/v1";

/** Mainnet USDC SAC — every snapshotted rate is quoted in USDC per 1 unit. */
export const USDC_ID = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

/** 1 unit in 7-dp stroops — the probe size the frontend quotes at, so the
 *  snapshotted history and the live cell agree. */
const PROBE_STROOPS = 10_000_000n;

/** Per-call ceiling. The cron has a whole tick, but a wedged upstream must not
 *  hold the scheduled handler open. */
const TIMEOUT_MS = 8000;

/**
 * Best-route price of `tokenInId` in USDC (out per 1 in), or null when Aquarius
 * has no route or is unreachable. Never throws — a missing rate writes NULL to
 * the snapshot row rather than failing the tick, so an Aquarius outage leaves a
 * visible gap in the series instead of a fabricated number.
 */
export async function aquariusPrice(tokenInId: string, tokenOutId: string = USDC_ID): Promise<number | null> {
  if (tokenInId === tokenOutId) return 1; // identity — USDC in USDC
  try {
    const res = await fetch(`${AQUARIUS_API}/find-path/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: tokenInId,
        token_out_address: tokenOutId,
        amount: PROBE_STROOPS.toString(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    if (!d.success || d.amount == null) return null;
    // Live mainnet returns `amount` as a JSON number; some deployments send a
    // string. Number() handles both; a NaN is rejected below.
    const out = Number(d.amount);
    if (!Number.isFinite(out) || out <= 0) return null;
    return out / Number(PROBE_STROOPS);
  } catch {
    return null;
  }
}
