/**
 * Pure ranking + trend maths behind the Compare Pools view — SCF T3.1 / T3.3.
 *
 * Split out of views/compare.ts so the two things the acceptance criteria name
 * (the "Best Rate" badge lands on the right row; the 24h/7d arrows are computed
 * from the T2 snapshot series) can be tested without a DOM.
 */

import type { SnapshotPoint } from "./history";

export type Trend = "up" | "down" | "flat";

/** Below this many APR percentage-points a move reads as noise, not a trend. */
export const FLAT_EPS = 0.05;

/**
 * Below this percent a DEX-rate move reads as noise. Looser than FLAT_EPS
 * because these are prices off an AMM: a rate wobbles by a few basis points
 * between ticks from ordinary trade flow, and that is not a trend.
 */
export const FLAT_EPS_PCT = 0.1;

export function trendOfDelta(d: number, eps = FLAT_EPS): Trend {
  if (!Number.isFinite(d) || Math.abs(d) < eps) return "flat";
  return d > 0 ? "up" : "down";
}

/** Trend across a whole series (first → last). */
export function trendOf(vals: number[]): Trend {
  if (vals.length < 2) return "flat";
  return trendOfDelta(vals[vals.length - 1] - vals[0]);
}

/** Points inside the trailing `days` window of an (oldest→newest) series. */
export function windowSlice(series: SnapshotPoint[], days: number, now = Date.now()): SnapshotPoint[] {
  const cutoff = now - days * 86_400_000;
  return series.filter((p) => p.ts >= cutoff);
}

/**
 * Rate delta over the trailing `hours`, in APR percentage points, straight from
 * the T2 `rate_snapshots` series (15-min cadence). The baseline is the oldest
 * snapshot still inside the window; null when the window holds < 2 points, so a
 * cold pool/asset renders "—" instead of a fabricated arrow.
 */
export function deltaOverHours(series: SnapshotPoint[], hours: number, now = Date.now()): number | null {
  const win = windowSlice(series, hours / 24, now);
  if (win.length < 2) return null;
  return win[win.length - 1].val - win[0].val;
}

/**
 * Percent change over the trailing `hours` — the right measure for a DEX rate,
 * where an absolute difference is meaningless across assets priced 0.0003 and
 * 1.16. Baseline is the oldest snapshot still inside the window. Null when the
 * window holds < 2 points or the baseline is non-positive (an asset cannot go
 * from a zero price to a real one; that is missing data, not a +∞% move).
 */
export function pctChangeOverHours(series: SnapshotPoint[], hours: number, now = Date.now()): number | null {
  const win = windowSlice(series, hours / 24, now);
  if (win.length < 2) return null;
  const first = win[0].val;
  if (!(first > 0)) return null;
  return ((win[win.length - 1].val - first) / first) * 100;
}

/** Linearly resample a series to `n` points for a steady sparkline density. */
export function resample(vals: number[], n: number): number[] {
  if (vals.length < 2) return vals;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const ti = (k / (n - 1)) * (vals.length - 1);
    const lo = Math.floor(ti),
      hi = Math.ceil(ti),
      f = ti - lo;
    out.push(vals[lo] * (1 - f) + vals[hi] * f);
  }
  return out;
}

/** Minimum shape the ranking needs — the view's CompareRow is a superset. */
export interface RankableRow {
  levApy: number;
}

/** Rank by leveraged net APY (desc). Ported from old-main.ts compareSortRows(). */
export function compareSortRows<T extends RankableRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.levApy - a.levApy);
}

/**
 * Index of rank 1 — the argmax of leveraged net APY, which carries the ★ in the
 * Rank column. Returns -1 for an empty list.
 *
 * This is *not* the "Best Rate" badge; that is `bestRateRowIndex`, which ranks
 * the same yield **net of what Aquarius says it costs to get in and out**. The
 * two coincide whenever trading cost does not change the winner, and diverge
 * exactly when it does — which is the interesting case.
 */
export function bestRowIndex<T extends RankableRow>(ranked: T[]): number {
  return ranked.length === 0 ? -1 : 0;
}

/** Minimum shape the "Best Rate" badge needs — CompareRow is a superset. */
export interface DexRankableRow {
  levApy: number;
  dexImpactBps: number | null;
}

/**
 * Holding period the one-off trading cost is spread over, in years.
 *
 * Entering and leaving a position is a *one-time* cost, but the APY it is being
 * subtracted from is annual — the two are only comparable once a holding period
 * is assumed. One year keeps the badge on the same basis as every other number
 * in the table; a shorter hold would weigh the cost more heavily and could
 * change the winner, which is why the tooltip states the assumption rather than
 * hiding it.
 */
export const HOLD_YEARS = 1;

/**
 * Round-trip trading cost as APY percentage points: the impact paid on the way
 * in plus the way out, annualised over `HOLD_YEARS`.
 *
 * Doubling assumes the exit costs what the entry did. We only measure
 * asset→USDC, and the reverse leg is close enough on an AMM that quoting it
 * separately would double the request count for a second-order correction.
 */
export function roundTripCostPp(impactBps: number): number {
  return (2 * impactBps) / 100 / HOLD_YEARS;
}

/**
 * Leveraged net APY minus the cost of entering and exiting the position at the
 * rate Aquarius is currently quoting. This is what the "Best Rate" badge ranks:
 * the return actually achievable, not the headline one.
 */
export function netOfCostApy(levApy: number, impactBps: number): number {
  return levApy - roundTripCostPp(impactBps);
}

/**
 * Below this many percentage points, two rows return the same in practice and
 * naming a winner would dress noise up as a recommendation. Matches the
 * `FLAT_EPS` convention used for APR movement.
 */
export const NET_TIE_EPS_PP = 0.05;

/**
 * Index of the row that carries the "Best Rate" badge: the argmax of
 * `netOfCostApy` — leveraged yield after the Aquarius round-trip cost of getting
 * into and out of it.
 *
 * Why not the argmax of `dexRate`: that column is USDC per 1 unit, so its argmax
 * is just whichever asset is denominated highest (EURC at 1.14 beating XLM at
 * 0.17 forever) — a badge that measures denomination and never moves.
 *
 * Why not the argmin of impact alone: that badges the asset that is cheapest to
 * trade, which on a leveraged-lending screen is not what a user is shopping for.
 * A 1497 bps round trip genuinely destroys a 6% yield, and a 0.3 bps one is
 * irrelevant next to a 26% one — only the combination ranks the rows the way the
 * money actually lands.
 *
 * Unlike a pure impact ranking this is **row-level**, not asset-level: the same
 * asset in three pools has one Aquarius rate but three different `levApy`, so the
 * badge lands on a specific row for a reason rather than by tiebreak.
 *
 * Rows with no impact measurement are not eligible — `null` means Aquarius had no
 * route, was unreachable, or only quoted the reference probe. Returns -1 when no
 * row is eligible, so an outage badges nothing rather than silently falling back
 * to rank 1 and implying a cost we could not verify.
 *
 * Ties inside `NET_TIE_EPS_PP` go to the earlier row; callers pass rows already
 * sorted by APY, so a tie breaks toward the better headline yield.
 */
export function bestRateRowIndex<T extends DexRankableRow>(rows: T[]): number {
  let best = -1;
  let bestNet = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < rows.length; i++) {
    const bps = rows[i].dexImpactBps;
    if (bps == null || !Number.isFinite(bps) || !Number.isFinite(rows[i].levApy)) continue;
    const net = netOfCostApy(rows[i].levApy, bps);
    if (net > bestNet + NET_TIE_EPS_PP) {
      best = i;
      bestNet = net;
    } else if (net > bestNet) {
      // Inside the tie band: keep the incumbent (earlier, higher-APY) row, but
      // track the better number so a third row must beat the real maximum.
      bestNet = net;
    }
  }
  return best;
}
