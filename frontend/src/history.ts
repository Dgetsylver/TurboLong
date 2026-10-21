/**
 * Server-backed rate history — SCF T3.1 / T3.3.
 *
 * The trend arrows + APY history chart previously read browser-local snapshots
 * only, so a fresh visitor saw "not enough history". This pulls the real
 * 15-minute server time-series from the alerts Worker's `/snapshots` endpoint
 * (T2.5) and merges it into the same localStorage keys those renderers consume,
 * so every visitor sees real 24h/7d/30d/1y history with no per-browser warm-up.
 */

export const ALERTS_WORKER_URL =
  (import.meta.env.VITE_ALERTS_WORKER_URL as string | undefined) ?? "https://turbolong-alerts.turbolong.workers.dev";

const RATE_HISTORY_KEY = "blendlev_rate_history";
const RATE_HISTORY_MAX = 4000; // 365d @ 15-min ≈ 35k; cap generously per key

export interface SnapshotPoint {
  ts: number;
  val: number;
}

/** Columns of `rate_snapshots` the UI trends. `dex_rate` (Aquarius, USDC per 1
 *  unit) is nullable per row — see the null handling in fetchSnapshotSeries. */
type Field = "net_supply_apr" | "net_borrow_cost" | "dex_rate";

/** Project one column of raw `/snapshots` rows into a series, oldest→newest. */
export function seriesFromRows(rows: Record<string, unknown>[], field: Field): SnapshotPoint[] {
  return (
    rows
      .filter((s) => s[field] != null) // `dex_rate` is NULL on ticks where Aquarius
      // gave no quote, and on every row predating the column. Number(null) is 0,
      // which is finite — so these must be dropped BEFORE the numeric filter or a
      // gap in the series would read as a rate of zero.
      .map((s) => ({
        ts: Date.parse(String(s.recorded_at).replace(" ", "T") + "Z"),
        val: Number(s[field]),
      }))
      .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.val))
      .reverse()
  ); // /snapshots returns newest-first → flip to oldest-first
}

/** Raw `/snapshots` rows for a pool/asset. Returns [] on any failure. */
async function fetchSnapshotRows(
  poolId: string,
  assetSymbol: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  try {
    const url =
      `${ALERTS_WORKER_URL}/snapshots?pool_id=${encodeURIComponent(poolId)}` +
      `&asset=${encodeURIComponent(assetSymbol)}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const d = (await res.json()) as { snapshots?: Record<string, unknown>[] };
    return d.snapshots ?? [];
  } catch {
    return [];
  }
}

/** Fetch the server time-series for a pool/asset, oldest→newest. */
export async function fetchSnapshotSeries(
  poolId: string,
  assetSymbol: string,
  field: Field,
  limit = 500,
): Promise<SnapshotPoint[]> {
  return seriesFromRows(await fetchSnapshotRows(poolId, assetSymbol, limit), field);
}

/**
 * Several columns from ONE request. The APR trend and the Aquarius rate trend
 * live in the same rows, so Compare pulls both per pool/asset — fetching them
 * separately would double the request count for identical payloads.
 */
export async function fetchSnapshotSeriesMulti<F extends Field>(
  poolId: string,
  assetSymbol: string,
  fields: readonly F[],
  limit = 500,
): Promise<Record<F, SnapshotPoint[]>> {
  const rows = await fetchSnapshotRows(poolId, assetSymbol, limit);
  const out = {} as Record<F, SnapshotPoint[]>;
  for (const f of fields) out[f] = seriesFromRows(rows, f);
  return out;
}

function key(poolId: string, assetId: string, field: string): string {
  return `${RATE_HISTORY_KEY}:${poolId}:${assetId}:${field}`;
}

/** Merge server points into a localStorage history key, deduped by minute. */
function mergeInto(storageKey: string, server: SnapshotPoint[]): void {
  if (server.length === 0) return;
  const raw = localStorage.getItem(storageKey);
  const local: SnapshotPoint[] = raw ? JSON.parse(raw) : [];
  const byMinute = new Map<number, SnapshotPoint>();
  for (const p of [...server, ...local]) {
    byMinute.set(Math.round(p.ts / 60_000), p); // local wins ties (more recent push)
  }
  const merged = [...byMinute.values()].sort((a, b) => a.ts - b.ts);
  const capped = merged.length > RATE_HISTORY_MAX ? merged.slice(-RATE_HISTORY_MAX) : merged;
  localStorage.setItem(storageKey, JSON.stringify(capped));
}

/**
 * Seed the supply-net + borrow-net history keys for a pool/asset from the server.
 * `assetSymbol` keys the server query; `assetId` (Soroban contract) keys
 * localStorage (matching the existing chart/arrow renderers). Returns true if any
 * server data was merged.
 */
export async function seedHistoryFromServer(poolId: string, assetId: string, assetSymbol: string): Promise<boolean> {
  const [supply, borrow] = await Promise.all([
    fetchSnapshotSeries(poolId, assetSymbol, "net_supply_apr"),
    fetchSnapshotSeries(poolId, assetSymbol, "net_borrow_cost"),
  ]);
  if (supply.length === 0 && borrow.length === 0) return false;
  mergeInto(key(poolId, assetId, "supply-net"), supply);
  mergeInto(key(poolId, assetId, "borrow-net"), borrow);
  return true;
}
