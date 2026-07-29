// T3.1 acceptance — Aquarius rate-comparison verification report.
//
// The Compare Pools view renders a "DEX Rate" per pool/asset (1 unit → USDC)
// and a "Best Rate" badge on the top-ranked row, both fed by Aquarius'
// find-path routing API (frontend/src/aquarius.ts). This tool re-queries that
// same public API for the mainnet asset pairs the UI shows and checks the
// numbers hold up, which is what the SCF measure asks for:
//
//   - live rate present for >= 5 asset pairs                    (COVERAGE)
//   - each rate reproduces on a re-quote within tolerance       (STABILITY)
//   - each rate round-trips (X->USDC->X) within a sane spread   (ROUND-TRIP)
//   - a 10x-larger probe still routes, i.e. real depth          (DEPTH)
//   - the Best Rate row is the max leveraged net APY it claims  (BADGE)
//
// The badge check is fed by --compare-json (a dump of the Compare rows) when
// available; without it the tool reports the badge rule it verified against and
// marks that line as not covered rather than inventing a result.
//
// Run (live):     npx tsx scripts/aquarius_rate_report.ts
// Run (offline):  npx tsx scripts/aquarius_rate_report.ts --fixture
// Out:            docs/evidence/aquarius-rate-report.md

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../docs/evidence");
const OUT_FILE = resolve(OUT_DIR, "aquarius-rate-report.md");

const DEFAULT_API = "https://amm-api.aqua.network/api/external/v1";
const MIN_PAIRS = 5; // SCF T3.1 acceptance: live rate for >= 5 asset pairs
const PROBE = 10_000_000n; // 1 unit, 7-dp stroops — same probe aquariusPrice() uses
const STABILITY_TOL_BPS = 50; // re-quote drift allowed between two calls
const ROUNDTRIP_MAX_BPS = 500; // X->USDC->X loss ceiling (AMM fees + slippage)

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

const API = arg("--api") ?? process.env.VITE_AQUARIUS_API ?? DEFAULT_API;

// ── Mainnet SAC contract ids (mirror of MAINNET_CONFIG in frontend/src/blend.ts) ──
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const ASSETS: { symbol: string; id: string }[] = [
  { symbol: "XLM", id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" },
  { symbol: "EURC", id: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV" },
  { symbol: "AQUA", id: "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK" },
  { symbol: "USDGLO", id: "CB226ZOEYXTBPD3QEGABTJYSKZVBP2PASEISLG3SBMTN5CE4QZUVZ3CE" },
  { symbol: "PYUSD", id: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2" },
  { symbol: "USTRY", id: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR" },
  { symbol: "CETES", id: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV" },
  { symbol: "TESOURO", id: "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS" },
];

interface Quote {
  amountOut: bigint;
  pools: string[];
  hops: number;
}

/** One find-path call. Mirrors frontend/src/aquarius.ts:aquariusBestRateResult. */
async function findPath(tokenIn: string, tokenOut: string, amount: bigint): Promise<Quote | null> {
  try {
    const res = await fetch(`${API}/find-path/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: tokenIn,
        token_out_address: tokenOut,
        amount: amount.toString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    if (!d.success || d.amount == null) return null;
    const pools = (d.pools as string[]) ?? [];
    return { amountOut: BigInt(d.amount as string | number), pools, hops: pools.length };
  } catch {
    return null;
  }
}

const bps = (a: number, b: number) => (b === 0 ? Number.NaN : ((a - b) / b) * 10_000);
const fmt = (n: number, dp = 6) => (Number.isFinite(n) ? n.toFixed(dp) : "n/a");

interface PairResult {
  symbol: string;
  rate: number | null; // USDC per 1 unit
  rate2: number | null; // re-quote
  stabilityBps: number | null;
  roundTripBps: number | null; // loss over X -> USDC -> X, negative = loss
  depthOk: boolean | null; // 10x probe still routes
  hops: number | null;
  pools: string[];
}

async function probePair(symbol: string, id: string): Promise<PairResult> {
  const r: PairResult = {
    symbol,
    rate: null,
    rate2: null,
    stabilityBps: null,
    roundTripBps: null,
    depthOk: null,
    hops: null,
    pools: [],
  };

  const q1 = await findPath(id, USDC, PROBE);
  if (!q1) return r;
  r.rate = Number(q1.amountOut) / Number(PROBE);
  r.hops = q1.hops;
  r.pools = q1.pools;

  // STABILITY — the same question asked twice must give the same answer.
  const q2 = await findPath(id, USDC, PROBE);
  if (q2) {
    r.rate2 = Number(q2.amountOut) / Number(PROBE);
    r.stabilityBps = bps(r.rate2, r.rate);
  }

  // ROUND-TRIP — sell the USDC we were quoted straight back; what returns
  // should be within AMM fees + slippage of the unit we started with. A rate
  // that is off by an order of magnitude (bad decimals, wrong token) blows up
  // here even though it looks plausible in isolation.
  const back = await findPath(USDC, id, q1.amountOut);
  if (back) r.roundTripBps = bps(Number(back.amountOut) / Number(PROBE), 1);

  // DEPTH — a rate quoted off a dust pool is not a rate a user can take.
  const deep = await findPath(id, USDC, PROBE * 10n);
  r.depthOk = deep != null;

  return r;
}

// ── Badge check ───────────────────────────────────────────────────────────────
// The Compare view badges rank 1 after sorting by levApy desc
// (frontend/src/views/compare.ts:compareSortRows). Given a dump of the rendered
// rows we re-run that rule; the badge is correct iff the badged row is the
// argmax of levApy.
interface CompareRowDump {
  poolName: string;
  symbol: string;
  levApy: number;
  dexRate: number | null;
  best?: boolean;
}

function checkBadge(rows: CompareRowDump[]): { ok: boolean; detail: string } {
  if (rows.length === 0) return { ok: false, detail: "no rows" };
  const top = rows.reduce((a, b) => (b.levApy > a.levApy ? b : a));
  const badged = rows.filter((r) => r.best);
  if (badged.length !== 1) return { ok: false, detail: `${badged.length} rows badged, expected exactly 1` };
  const ok = badged[0].symbol === top.symbol && badged[0].poolName === top.poolName;
  return {
    ok,
    detail: ok
      ? `badged ${top.poolName}/${top.symbol} at ${top.levApy.toFixed(2)}% levAPY = argmax over ${rows.length} rows`
      : `badged ${badged[0].poolName}/${badged[0].symbol} but argmax is ${top.poolName}/${top.symbol}`,
  };
}

// ── Deterministic fixture (offline demo / CI) ────────────────────────────────
function fixtureResults(): PairResult[] {
  const mk = (symbol: string, rate: number, hops: number, stab: number, rt: number): PairResult => ({
    symbol,
    rate,
    rate2: rate * (1 + stab / 10_000),
    stabilityBps: stab,
    roundTripBps: rt,
    depthOk: true,
    hops,
    pools: Array.from({ length: hops }, (_, i) => `CPOOL_${symbol}_${i}`),
  });
  return [
    mk("XLM", 0.1747183, 4, 0.0, -61),
    mk("EURC", 1.1642, 2, 1.2, -38),
    mk("AQUA", 0.0004112, 3, -2.4, -94),
    mk("USDGLO", 0.9991, 2, 0.0, -22),
    mk("PYUSD", 0.9998, 2, 0.3, -19),
    mk("USTRY", 0.0243, 3, -1.1, -120),
  ];
}

// ── Report ───────────────────────────────────────────────────────────────────
function render(results: PairResult[], badge: { ok: boolean; detail: string } | null, live: boolean): string {
  const priced = results.filter((r) => r.rate != null);
  const stable = priced.filter((r) => r.stabilityBps != null && Math.abs(r.stabilityBps) <= STABILITY_TOL_BPS);
  const rt = priced.filter((r) => r.roundTripBps != null && Math.abs(r.roundTripBps) <= ROUNDTRIP_MAX_BPS);
  const deep = priced.filter((r) => r.depthOk === true);

  const pass = (b: boolean) => (b ? "PASS" : "FAIL");
  const L: string[] = [];

  L.push("# Aquarius rate comparison — T3.1 acceptance evidence");
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push(`Source: \`${API}\` (\`POST /find-path/\`, strict-send)`);
  L.push(`Mode: ${live ? "**live**" : "**fixture** (offline; not acceptance evidence)"}`);
  L.push(`Probe: 1 unit (${PROBE} stroops) of each asset → USDC`);
  L.push("");
  L.push("## Verdict");
  L.push("");
  L.push("| Check | Target | Result | Status |");
  L.push("| --- | --- | --- | --- |");
  L.push(`| Coverage — pairs with a live rate | ≥ ${MIN_PAIRS} | ${priced.length} | ${pass(priced.length >= MIN_PAIRS)} |`);
  L.push(
    `| Stability — re-quote drift | ≤ ${STABILITY_TOL_BPS} bps | ${stable.length}/${priced.length} within | ${pass(stable.length === priced.length && priced.length > 0)} |`,
  );
  L.push(
    `| Round-trip — X→USDC→X loss | ≤ ${ROUNDTRIP_MAX_BPS} bps | ${rt.length}/${priced.length} within | ${pass(rt.length === priced.length && priced.length > 0)} |`,
  );
  L.push(
    `| Depth — 10× probe still routes | all priced pairs | ${deep.length}/${priced.length} | ${pass(deep.length === priced.length && priced.length > 0)} |`,
  );
  L.push(
    `| Best Rate badge = argmax(levAPY) | exactly 1 badged row | ${badge ? badge.detail : "covered by unit test, not by this run — pass --compare-json to check rendered rows"} | ${badge ? pass(badge.ok) : "see `frontend/test/compare_metrics.test.ts`"} |`,
  );
  L.push("");
  L.push("## Per-pair detail");
  L.push("");
  L.push("| Pair | Rate (USDC per 1) | Re-quote | Drift (bps) | Round-trip (bps) | 10× depth | Hops |");
  L.push("| --- | ---: | ---: | ---: | ---: | :---: | ---: |");
  for (const r of results) {
    if (r.rate == null) {
      L.push(`| ${r.symbol}/USDC | no route | — | — | — | — | — |`);
      continue;
    }
    L.push(
      `| ${r.symbol}/USDC | ${fmt(r.rate)} | ${r.rate2 == null ? "—" : fmt(r.rate2)} | ` +
        `${r.stabilityBps == null ? "—" : r.stabilityBps.toFixed(1)} | ` +
        `${r.roundTripBps == null ? "—" : r.roundTripBps.toFixed(0)} | ` +
        `${r.depthOk == null ? "—" : r.depthOk ? "yes" : "no"} | ${r.hops ?? "—"} |`,
    );
  }
  L.push("");
  L.push("## Routes taken");
  L.push("");
  for (const r of results.filter((x) => x.pools.length > 0)) {
    L.push(`- **${r.symbol}/USDC** — ${r.hops} hop(s): ${r.pools.map((p) => `\`${p}\``).join(" → ")}`);
  }
  L.push("");
  L.push("## What the UI does with this");
  L.push("");
  L.push(
    "- `frontend/src/views/compare.ts` renders the **DEX Rate** column from `aquariusPriceResult(asset → USDC)` — the same `find-path` call and the same 1-unit probe measured above.",
  );
  L.push(
    "- The **Best Rate** badge marks rank 1 after `compareSortRows` → `bestRowIndex` (leveraged net APY, descending) in `frontend/src/compare_metrics.ts`; `frontend/test/compare_metrics.test.ts` asserts exactly one row is badged and that it is the argmax. Pass `--compare-json <dump>` here to re-run the same rule against rendered rows.",
  );
  L.push(
    "- The **24h / 7d rate arrows** under each DEX Rate come from `rate_snapshots.dex_rate` — the same quote, snapshotted every 15 min by the alerts cron (`alerts/src/aquarius.ts`) — via `GET /snapshots`. NULL ticks are dropped, so an outage thins the window instead of reading as a rate of zero.",
  );
  L.push(
    "- The **Trend column** arrows track `net_supply_apr` (Blend), not Aquarius — an Aquarius outage does not affect them.",
  );
  L.push("- Fallback behaviour when Aquarius is unreachable: `docs/aquarius-rate-fallback.md`.");
  L.push("");
  return L.join("\n");
}

async function main() {
  const fixture = hasFlag("--fixture");
  let results: PairResult[];

  if (fixture) {
    results = fixtureResults();
  } else {
    results = [];
    // Sequential: the public API is unauthenticated and rate-limited.
    for (const a of ASSETS) {
      process.stderr.write(`probing ${a.symbol}/USDC … `);
      const r = await probePair(a.symbol, a.id);
      process.stderr.write(`${r.rate == null ? "no route" : fmt(r.rate)}\n`);
      results.push(r);
    }
  }

  let badge: { ok: boolean; detail: string } | null = null;
  const dump = arg("--compare-json");
  if (dump) badge = checkBadge(JSON.parse(readFileSync(resolve(dump), "utf8")) as CompareRowDump[]);
  else if (fixture) {
    badge = checkBadge([
      { poolName: "YieldBlox", symbol: "XLM", levApy: 18.4, dexRate: 0.1747183, best: true },
      { poolName: "Fixed XLM-USDC", symbol: "USDC", levApy: 11.2, dexRate: 1 },
      { poolName: "YieldBlox", symbol: "EURC", levApy: 7.9, dexRate: 1.1642 },
    ]);
  }

  const md = render(results, badge, !fixture);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, md, "utf8");
  process.stderr.write(`\nwrote ${OUT_FILE}\n`);

  const priced = results.filter((r) => r.rate != null).length;
  if (!fixture && priced < MIN_PAIRS) {
    process.stderr.write(`FAIL: only ${priced} priced pairs, need >= ${MIN_PAIRS}\n`);
    process.exitCode = 1;
  }
}

void main();
