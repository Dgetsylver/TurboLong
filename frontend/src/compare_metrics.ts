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
 * Index of the row that carries the "Best Rate" badge: rank 1 of the ranked
 * list, i.e. the argmax of leveraged net APY. Returns -1 for an empty list so
 * no row is ever badged by accident.
 */
export function bestRowIndex<T extends RankableRow>(ranked: T[]): number {
  return ranked.length === 0 ? -1 : 0;
}
