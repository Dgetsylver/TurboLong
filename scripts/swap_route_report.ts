// T2.1 acceptance — Broker-vs-Soroswap A/B report generator.
//
// The keeper logs every harvest swap (Broker quote vs Soroswap quote, which was
// chosen, realized uplift) to the alerts Worker's `swap_routes` table via
// POST /swap-routes (alerts/src/index.ts). GET /swap-routes returns server-side
// global aggregates + recent rows. This tool turns that into the acceptance
// report, adding what the endpoint doesn't compute: per-asset breakdown, median
// uplift, the Broker/Soroswap chosen split, and progress vs the ≥50-harvest
// acceptance target.
//
// Run (live):     npx tsx scripts/swap_route_report.ts --url https://turbolong-alerts.workers.dev --network mainnet
// Run (offline):  npx tsx scripts/swap_route_report.ts --fixture
// Out:            docs/evidence/swap-route-report.md

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../docs/evidence");
const TARGET_HARVESTS = 50; // T2.1 acceptance: ≥50 mainnet harvests with both quotes

interface Row {
  asset_symbol: string;
  chosen: string; // "broker" | "soroswap"
  uplift_bps: number | null;
  slippage_bps: number | null;
  status: string; // "executed" | ...
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ── Deterministic fixture (offline demo / test) ──────────────────────────────
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 0x100000000);
}
function fixtureRows(n: number): Row[] {
  const rnd = lcg(20260613);
  const assets = ["USDC", "USTRY", "CETES", "XLM"];
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    // Broker wins ~65% of the time; uplift is the bps advantage of the chosen route.
    const brokerWins = rnd() < 0.65;
    const uplift = Math.round((brokerWins ? 4 + rnd() * 40 : rnd() * 6) * 10) / 10;
    out.push({
      asset_symbol: assets[Math.floor(rnd() * assets.length)],
      chosen: brokerWins ? "broker" : "soroswap",
      uplift_bps: uplift,
      slippage_bps: Math.round(rnd() * 30),
      status: "executed",
    });
  }
  return out;
}

interface ServerReport {
  network?: string;
  total?: number;
  executed?: number;
  broker_wins?: number;
  broker_win_rate?: number | null;
  avg_uplift_bps?: number | null;
  avg_slippage_bps?: number | null;
}

async function fetchData(url: string, network: string): Promise<{ report: ServerReport; rows: Row[] }> {
  const res = await fetch(`${url}/swap-routes?network=${encodeURIComponent(network)}&limit=500`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET /swap-routes → HTTP ${res.status}`);
  const d = (await res.json()) as { report?: ServerReport; rows?: Row[] };
  return { report: d.report ?? {}, rows: (d.rows ?? []).map((r) => ({ ...r, uplift_bps: r.uplift_bps == null ? null : Number(r.uplift_bps) })) };
}

// ── Aggregate ────────────────────────────────────────────────────────────────
function perAsset(rows: Row[]) {
  const byAsset = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.status !== "executed") continue;
    (byAsset.get(r.asset_symbol) ?? byAsset.set(r.asset_symbol, []).get(r.asset_symbol)!).push(r);
  }
  return [...byAsset.entries()]
    .map(([asset, rs]) => {
      const brokerWins = rs.filter((r) => r.chosen === "broker").length;
      const uplifts = rs.map((r) => r.uplift_bps).filter((u): u is number => u != null);
      return {
        asset,
        n: rs.length,
        brokerWinRate: rs.length ? brokerWins / rs.length : 0,
        avgUplift: mean(uplifts),
        medUplift: median(uplifts),
      };
    })
    .sort((a, b) => b.n - a.n);
}

async function main() {
  const fixture = hasFlag("--fixture");
  const url = arg("--url") ?? "https://turbolong-alerts.workers.dev";
  const network = arg("--network") ?? (fixture ? "mainnet" : "mainnet");

  let report: ServerReport;
  let rows: Row[];
  let source: string;
  if (fixture) {
    rows = fixtureRows(60);
    const ex = rows.filter((r) => r.status === "executed");
    const bw = ex.filter((r) => r.chosen === "broker").length;
    report = {
      network: "mainnet (FIXTURE)",
      total: rows.length,
      executed: ex.length,
      broker_wins: bw,
      broker_win_rate: ex.length ? bw / ex.length : null,
      avg_uplift_bps: mean(ex.map((r) => r.uplift_bps).filter((u): u is number => u != null)),
      avg_slippage_bps: mean(ex.map((r) => r.slippage_bps).filter((u): u is number => u != null)),
    };
    source = "synthetic fixture (deterministic, seed 20260613)";
  } else {
    ({ report, rows } = await fetchData(url, network));
    source = `${url}/swap-routes?network=${network}`;
  }

  const executed = Number(report.executed ?? 0);
  const assets = perAsset(rows);
  const allUplift = rows.filter((r) => r.status === "executed").map((r) => r.uplift_bps).filter((u): u is number => u != null);
  const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  const bps = (x: number | null | undefined) => (x == null ? "—" : `${x.toFixed(1)} bps`);

  const md = `# T2.1 Acceptance — Broker vs Soroswap A/B Report

Source: \`${source}\`${fixture ? "  ⚠️ FIXTURE (no live data yet)" : ""}

## Acceptance target: ≥ ${TARGET_HARVESTS} executed harvests with both quotes logged
**${executed} / ${TARGET_HARVESTS}** executed — ${executed >= TARGET_HARVESTS ? "✅ met" : `⏳ ${TARGET_HARVESTS - executed} to go`}

## Summary
| Metric | Value |
|--------|-------|
| Total routes logged | ${report.total ?? 0} |
| Executed | ${executed} |
| Broker chosen (win rate) | ${report.broker_wins ?? 0} (${pct(report.broker_win_rate)}) |
| Soroswap chosen | ${executed - Number(report.broker_wins ?? 0)} |
| Avg uplift (chosen vs alt) | ${bps(report.avg_uplift_bps)} |
| Median uplift | ${bps(median(allUplift))} |
| Avg slippage | ${bps(report.avg_slippage_bps)} |

## Per-asset breakdown
| Asset | Harvests | Broker win-rate | Avg uplift | Median uplift |
|-------|----------|-----------------|------------|---------------|
${assets.map((a) => `| ${a.asset} | ${a.n} | ${pct(a.brokerWinRate)} | ${bps(a.avgUplift)} | ${bps(a.medUplift)} |`).join("\n") || "| — | — | — | — | — |"}

> Uplift = bps advantage of the chosen route over the alternative quote at
> execution. Broker-win-rate = share of executed harvests where the off-chain
> Stellar Broker quote beat Soroswap. The keeper logs each harvest via
> POST /swap-routes; run this against the live Worker once ≥${TARGET_HARVESTS}
> mainnet harvests have accrued for the filing-ready figure.
`;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "swap-route-report.md"), md);
  console.log(md);
  console.log(`\nWrote docs/evidence/swap-route-report.md (${executed} executed, ${assets.length} assets)`);
}

main().catch((e) => {
  console.error("swap_route_report failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
