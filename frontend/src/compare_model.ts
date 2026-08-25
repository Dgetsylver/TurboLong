/**
 * Compare-screen model — pure, DOM-free logic behind the Compare Pools view (A9).
 *
 * Split out of views/compare.ts so the parts that decide what a user sees —
 * which points fall in the 7d/30d/1y window, the net APY at each leverage
 * bracket, the cross-pool ranking, and the chart geometry — are unit-testable
 * and measurable in node (no jsdom in this repo's vitest run).
 *
 * Two data sources meet here, one per axis:
 *   - Aquarius (frontend/src/aquarius.ts) → indicative DEX rate per asset
 *   - the T2 snapshot service (frontend/src/history.ts) → net-supply-APR series
 */

import type { SnapshotPoint } from "./history";

// ── APR → APY ────────────────────────────────────────────────────────────────

/** Daily-compounding APR → APY, in percent. */
export const aprToApy = (apr: number) => (Math.pow(1 + apr / 100 / 365, 365) - 1) * 100;

// ── History windows ──────────────────────────────────────────────────────────

export type Win = "7D" | "30D" | "1Y";
export const WINS: Win[] = ["7D", "30D", "1Y"];
export const WIN_DAYS: Record<Win, number> = { "7D": 7, "30D": 30, "1Y": 365 };
/** Points to resample a window to — enough shape without oversampling the SVG. */
export const WIN_POINTS: Record<Win, number> = { "7D": 28, "30D": 40, "1Y": 52 };
export const WIN_LABEL: Record<Win, string> = { "7D": "7d", "30D": "30d", "1Y": "1y" };

/**
 * Points falling inside `win`, oldest→newest.
 *
 * The window chips previously only changed sparkline density: every chip
 * rendered the same full-year series, so "7D" and "1Y" drew identical trends
 * and the trend arrow always described a year. Slicing by timestamp is what
 * makes the chips mean anything.
 */
export function sliceWindow(series: SnapshotPoint[], win: Win, now: number = Date.now()): SnapshotPoint[] {
  const cutoff = now - WIN_DAYS[win] * 86_400_000;
  return series.filter((p) => p.ts >= cutoff);
}

/** Linearly resample to `n` points for steady chart density. */
export function resample(vals: number[], n: number): number[] {
  if (n < 2 || vals.length < 2) return vals.slice();
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const ti = (k / (n - 1)) * (vals.length - 1);
    const lo = Math.floor(ti);
    const hi = Math.min(lo + 1, vals.length - 1);
    const f = ti - lo;
    out.push(vals[lo] * (1 - f) + vals[hi] * f);
  }
  return out;
}

// ── Trend arrows ─────────────────────────────────────────────────────────────

export type Trend = "up" | "down" | "flat";
/** Below this end-to-end move (percentage points) a window reads as flat. */
export const TREND_EPSILON = 0.05;
export const ARROW: Record<Trend, string> = { up: "▲", down: "▼", flat: "—" };

export function trendOf(vals: number[]): Trend {
  if (vals.length < 2) return "flat";
  const d = vals[vals.length - 1] - vals[0];
  if (Math.abs(d) < TREND_EPSILON) return "flat";
  return d > 0 ? "up" : "down";
}

/** End-to-end change over the window, in percentage points (0 when < 2 points). */
export function trendDelta(vals: number[]): number {
  return vals.length < 2 ? 0 : vals[vals.length - 1] - vals[0];
}

// ── Leverage brackets ────────────────────────────────────────────────────────

/** Fixed brackets plus "max" = the carry-optimal leverage the Trade form allows. */
export type Bracket = 2 | 3 | 5 | 10 | "max";
export const BRACKETS: Bracket[] = [2, 3, 5, 10, "max"];
export const bracketLabel = (b: Bracket) => (b === "max" ? "Max" : `${b}×`);

/** Row shape the ranking works on — structural, so tests need no chain data. */
export interface CompareRowData {
  poolName: string;
  poolId: string;
  assetSymbol: string;
  assetId: string;
  /** % pa, supply interest + BLND emissions. */
  netSupplyApr: number;
  /** % pa, borrow interest − emissions. */
  netBorrowCost: number;
  /** Max leverage at the Trade form's minimum health factor. */
  safeLev: number;
  /** Indicative Aquarius quote, 1 unit → USDC; null = no route. */
  dexRate: number | null;
  /** Net-supply-APR history from the T2 snapshot service, oldest→newest. */
  series: SnapshotPoint[];
}

export interface BracketResult {
  /** Leverage actually used — the bracket, clamped to what minHF permits. */
  lev: number;
  /** Net APY at `lev`, in %. */
  apy: number;
  /** The requested bracket exceeds safeLev, so `lev` was clamped down. */
  capped: boolean;
}

/** Net APY of a loop held at `lev`: supply on the whole stack, borrow on the
 *  leveraged part. lev = 1 is the unlevered base APY. */
export function netApyAtLeverage(row: Pick<CompareRowData, "netSupplyApr" | "netBorrowCost">, lev: number): number {
  return aprToApy(row.netSupplyApr * lev - row.netBorrowCost * (lev - 1));
}

/** Base (unlevered) APY. */
export const baseApy = (row: Pick<CompareRowData, "netSupplyApr">) => aprToApy(row.netSupplyApr);

/**
 * Net APY for a row at one bracket.
 *
 * "max" is carry-optimal, not merely maximal: when the carry
 * (netSupplyApr − netBorrowCost) is negative, every extra leverage unit loses
 * money, so the optimum is to stay unlevered at 1×. Numeric brackets clamp to
 * safeLev — asking for 10× on a reserve that tops out at 3.2× reports 3.2×
 * and flags itself, rather than quoting a position nobody can open.
 */
export function bracketApy(row: CompareRowData, bracket: Bracket): BracketResult {
  const safe = Math.max(1, row.safeLev);
  if (bracket === "max") {
    const carry = row.netSupplyApr - row.netBorrowCost;
    const lev = carry > 0 ? safe : 1;
    return { lev, apy: netApyAtLeverage(row, lev), capped: false };
  }
  const lev = Math.min(bracket, safe);
  return { lev, apy: netApyAtLeverage(row, lev), capped: bracket > safe };
}

export interface RankedRow<T extends CompareRowData = CompareRowData> {
  row: T;
  rank: number; // 1-based
  result: BracketResult;
}

/** Cross-pool ranking at one bracket — best net APY first. Ties break on the
 *  lower leverage (same yield for less risk), then pool/asset for stability. */
export function rankRows<T extends CompareRowData>(rows: T[], bracket: Bracket): RankedRow<T>[] {
  return rows
    .map((row) => ({ row, result: bracketApy(row, bracket), rank: 0 }))
    .sort(
      (a, b) =>
        b.result.apy - a.result.apy ||
        a.result.lev - b.result.lev ||
        a.row.poolName.localeCompare(b.row.poolName) ||
        a.row.assetSymbol.localeCompare(b.row.assetSymbol),
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ── Chart geometry ───────────────────────────────────────────────────────────

export interface ChartGeometry {
  /** SVG path for the line. */
  line: string;
  /** SVG path for the area fill under the line, closed along the baseline. */
  area: string;
  min: number;
  max: number;
  first: number;
  last: number;
  /** Pixel coords of the last point, for the end dot. */
  lastX: number;
  lastY: number;
}

/**
 * Line + area path data for a value series in a `width`×`height` viewBox.
 *
 * Pure string building — no DOM — so the per-asset charts can be measured and
 * regression-tested in node. A flat series gets a mid-height line rather than
 * collapsing onto an edge.
 */
export function chartGeometry(vals: number[], width: number, height: number, pad = 3): ChartGeometry | null {
  if (vals.length < 2 || width <= pad * 2 || height <= pad * 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const x = (i: number) => pad + (i / (vals.length - 1)) * innerW;
  // Flat series: centre the line instead of pinning it to the bottom edge.
  const y = (v: number) => (span === 0 ? pad + innerH / 2 : pad + innerH - ((v - min) / span) * innerH);

  let line = "";
  for (let i = 0; i < vals.length; i++) {
    line += `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`;
  }
  const baseline = (height - pad).toFixed(1);
  const area = `${line}L${x(vals.length - 1).toFixed(1)},${baseline}L${x(0).toFixed(1)},${baseline}Z`;

  return {
    line,
    area,
    min,
    max,
    first: vals[0],
    last: vals[vals.length - 1],
    lastX: Number(x(vals.length - 1).toFixed(1)),
    lastY: Number(y(vals[vals.length - 1]).toFixed(1)),
  };
}

/** Evenly spaced date ticks across a window, for the chart x-axis. */
export function axisTicks(series: SnapshotPoint[], count = 3): string[] {
  if (series.length === 0) return [];
  const fmt = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (series.length === 1 || count < 2) return [fmt(series[0].ts)];
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    out.push(fmt(series[Math.round((k / (count - 1)) * (series.length - 1))].ts));
  }
  return out;
}
