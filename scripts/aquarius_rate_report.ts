// T3.1 acceptance — Aquarius rate-comparison verification report.
//
// The Compare Pools view renders a "DEX Rate" per pool/asset (1 unit → USDC)
// and a "Best Rate" badge, both fed by Aquarius' find-path routing API
// (frontend/src/aquarius.ts). This tool re-queries that same public API for the
// mainnet asset pairs the UI shows and checks the numbers hold up, which is what
// the SCF measure asks for:
//
//   - live rate present for >= 5 asset pairs                    (COVERAGE)
//   - each rate reproduces on a re-quote within tolerance       (STABILITY)
//   - each rate round-trips (X->USDC->X) within a sane spread   (ROUND-TRIP)
//   - a 10x-larger probe still routes, i.e. real depth          (DEPTH)
//   - every priced pair yields a usable price impact, which is
//     the Aquarius half of the badge input                       (BADGE INPUT)
//   - the Best Rate badge lands on the argmax of leveraged APY
//     minus the Aquarius round-trip cost                         (BADGE)
//
// The badge ranks `levApy - 2 x impact` over a HOLD_YEARS hold. Half of that is
// Blend reserve data this tool does not query, so the ranking check requires
// --compare-json (a dump of the rendered Compare rows): the dump supplies levApy
// and which row was badged, this run supplies the live impact, and the rule
// itself is imported from the frontend so the verdict cannot drift from what
// ships. Without a dump the tool verifies the Aquarius input only, and says so
// rather than inventing APYs to assert a ranking with.
//
// Run (live):     npx tsx scripts/aquarius_rate_report.ts
// Run (offline):  npx tsx scripts/aquarius_rate_report.ts --fixture
// Out:            docs/evidence/aquarius-rate-report.md

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The real ranking rule, imported rather than copied. compare_metrics.ts is pure
// (its only import is type-only), so it loads under tsx without the frontend's
// import.meta.env / DOM surface.
import { bestRateRowIndex, HOLD_YEARS, netOfCostApy, roundTripCostPp } from "../frontend/src/compare_metrics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../docs/evidence");
const OUT_FILE = resolve(OUT_DIR, "aquarius-rate-report.md");

const DEFAULT_API = "https://amm-api.aqua.network/api/external/v1";
const MIN_PAIRS = 5; // SCF T3.1 acceptance: live rate for >= 5 asset pairs
const PROBE = 10_000_000n; // 1 unit, 7-dp stroops — same probe aquariusPrice() uses
const STABILITY_TOL_BPS = 50; // re-quote drift allowed between two calls
const ROUNDTRIP_MAX_BPS = 500; // X->USDC->X loss ceiling (AMM fees + slippage)
// Trade size the badge's price-impact comparison uses. Keep in sync with
// IMPACT_NOTIONAL in frontend/src/aquarius.ts — that is the source of truth.
const IMPACT_NOTIONAL = 10_000;

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
  await sleep(DELAY_MS);
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

/**
 * Gap between calls. A full run is 5 probes × 8 assets; fired back to back that
 * is enough to get throttled, and a throttled `find-path` answers exactly like a
 * pair with no route — which would show up here as a spurious coverage FAIL.
 * Override with --delay-ms for a faster (riskier) run.
 */
const DELAY_MS = Number(arg("--delay-ms") ?? 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PairResult {
  symbol: string;
  rate: number | null; // USDC per 1 unit
  rate2: number | null; // re-quote
  stabilityBps: number | null;
  roundTripBps: number | null; // loss over X -> USDC -> X, negative = loss
  depthOk: boolean | null; // 10x probe still routes
  impactBps: number | null; // per-unit rate lost at IMPACT_NOTIONAL — the badge input
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
    impactBps: null,
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

  // IMPACT — the badge input. Same two probes aquariusRateWithImpact() makes:
  // the 1-unit reference above, then the same route at IMPACT_NOTIONAL of
  // output. Sized by notional, not by unit count, so the number is comparable
  // across assets priced $0.0003 and $1.14.
  const sizedStroops = BigInt(Math.round((IMPACT_NOTIONAL / r.rate) * Number(PROBE)));
  if (sizedStroops <= PROBE) {
    r.impactBps = 0;
  } else {
    const sized = await findPath(id, USDC, sizedStroops);
    if (sized) {
      const rateAtSize = Number(sized.amountOut) / Number(sizedStroops);
      // Clamped like the client: a negative is rounding on a deep stable pair,
      // not a better rate for trading more.
      r.impactBps = Math.max(0, ((r.rate - rateAtSize) / r.rate) * 10_000);
    }
  }

  return r;
}

// ── Badge check ───────────────────────────────────────────────────────────────
// The Compare view badges the Aquarius route with the lowest price impact at
// IMPACT_NOTIONAL (frontend/src/compare_metrics.ts:bestRateRowIndex). Both the
// rule and its input are checked here against the live routing API: we feed the
// impacts measured above through the shipped rule and confirm it lands on the
// argmin.
interface BadgeCheck {
  ok: boolean;
  detail: string;
  /** Row the badge landed on, so the table can mark the same one. */
  symbol?: string;
}

/**
 * The half of the badge this script can verify on its own.
 *
 * The badge ranks `levApy − roundTripCost`, and `levApy` is Blend reserve data
 * over Soroban RPC — nothing this tool queries. So a standalone run verifies the
 * **Aquarius input**: that every priced pair yields a usable price impact, which
 * is what the cost side of the ranking is computed from. The ranking itself
 * needs --compare-json; there is no way to fake it from Aquarius alone, and
 * asserting it from this script would mean inventing APYs.
 */
function checkImpactInputs(results: PairResult[]): BadgeCheck {
  const priced = results.filter((r) => r.rate != null);
  const measured = priced.filter((r) => r.impactBps != null);
  const missing = priced.filter((r) => r.impactBps == null).map((r) => r.symbol);
  const ok = measured.length === priced.length && priced.length > 0;
  return {
    ok,
    detail: ok
      ? `${measured.length}/${priced.length} priced pairs yielded a usable impact ` +
        `(${Math.min(...measured.map((r) => r.impactBps as number)).toFixed(1)}–` +
        `${Math.max(...measured.map((r) => r.impactBps as number)).toFixed(1)} bps)`
      : `${measured.length}/${priced.length} priced pairs yielded an impact; missing: ${missing.join(", ") || "none"}`,
  };
}

/**
 * The full badge check, and the only one that can exist: re-rank the rendered
 * rows by `levApy − roundTripCost(live impact)` and confirm the UI badged the
 * argmax. The dump supplies the Blend half (levApy per row), this run supplies
 * the Aquarius half (impact per asset), and `bestRateRowIndex` — imported from
 * the frontend — supplies the rule. Nothing here is a reimplementation.
 */
interface CompareRowDump {
  poolName: string;
  symbol: string;
  levApy: number;
  dexRate: number | null;
  best?: boolean;
}

function checkBadgeRendered(rows: CompareRowDump[], results: PairResult[]): BadgeCheck {
  if (rows.length === 0) return { ok: false, detail: "no rows in dump" };
  const badgedRows = rows.filter((r) => r.best);
  if (badgedRows.length !== 1) return { ok: false, detail: `${badgedRows.length} rows badged, expected exactly 1` };

  // Attach this run's live impact to each rendered row. USDC needs no swap in
  // either direction, so its cost is a real zero rather than missing data —
  // matching how the view populates it.
  const impactOf = (sym: string): number | null => {
    if (sym.toUpperCase() === "USDC") return 0;
    return results.find((r) => r.symbol.toUpperCase() === sym.toUpperCase())?.impactBps ?? null;
  };
  const ranked = rows.map((r) => ({ ...r, dexImpactBps: impactOf(r.symbol) }));
  const priceable = ranked.filter((r) => r.dexImpactBps != null);
  if (priceable.length === 0) {
    return { ok: false, detail: "no rendered row could be priced against this run — nothing to rank" };
  }

  // Rows must be in the order the view ranks them (levApy desc) for the tie
  // band to break the same way it does on screen.
  const inViewOrder = [...ranked].sort((a, b) => b.levApy - a.levApy);
  const idx = bestRateRowIndex(inViewOrder);
  if (idx < 0) return { ok: false, detail: "rule badged nothing despite priceable rows" };
  const expected = inViewOrder[idx];
  const actual = badgedRows[0];

  const ok =
    expected.symbol.toUpperCase() === actual.symbol.toUpperCase() && expected.poolName === actual.poolName;
  const net = (r: (typeof inViewOrder)[number]) => netOfCostApy(r.levApy, r.dexImpactBps as number);
  const runnerUp = priceable
    .filter((r) => r !== expected)
    .sort((a, b) => net(b) - net(a))[0];
  const unpriced = ranked.filter((r) => r.dexImpactBps == null).map((r) => r.symbol);
  const note = unpriced.length ? `; unpriced this run: ${[...new Set(unpriced)].join(", ")}` : "";

  return {
    ok,
    symbol: actual.symbol,
    detail: ok
      ? `rendered badge on ${actual.poolName}/${actual.symbol} = argmax of APY − round-trip cost across ` +
        `${priceable.length} priceable rows: ${expected.levApy.toFixed(2)}% − ` +
        `${roundTripCostPp(expected.dexImpactBps as number).toFixed(2)}pp = ${net(expected).toFixed(2)}% net` +
        (runnerUp ? ` (next ${runnerUp.symbol} at ${net(runnerUp).toFixed(2)}%)` : "") +
        note
      : `rendered badge on ${actual.poolName}/${actual.symbol}, but the rule ranks ` +
        `${expected.poolName}/${expected.symbol} highest at ${net(expected).toFixed(2)}% net${note}`,
  };
}

// ── Deterministic fixture (offline demo / CI) ────────────────────────────────
function fixtureResults(): PairResult[] {
  const mk = (symbol: string, rate: number, hops: number, stab: number, rt: number, impact: number): PairResult => ({
    symbol,
    rate,
    rate2: rate * (1 + stab / 10_000),
    stabilityBps: stab,
    roundTripBps: rt,
    depthOk: true,
    impactBps: impact,
    hops,
    pools: Array.from({ length: hops }, (_, i) => `CPOOL_${symbol}_${i}`),
  });
  // Impacts mirror the shape of a real run: stables near zero, thin assets wide.
  return [
    mk("XLM", 0.1747183, 4, 0.0, -61, 29.5),
    mk("EURC", 1.1642, 2, 1.2, -38, 40.2),
    mk("AQUA", 0.0004112, 3, -2.4, -94, 74.9),
    mk("USDGLO", 0.9991, 2, 0.0, -22, 0.3),
    mk("PYUSD", 0.9998, 2, 0.3, -19, 0.0),
    mk("USTRY", 0.0243, 3, -1.1, -120, 118.2),
  ];
}

// ── Report ───────────────────────────────────────────────────────────────────
function render(
  results: PairResult[],
  badge: BadgeCheck,
  rendered: BadgeCheck | null,
  live: boolean,
): string {
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
  L.push(`Badge probe: ~${IMPACT_NOTIONAL.toLocaleString("en-US")} USDC of notional per asset`);
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
  L.push(`| Badge input — price impact measurable | all priced pairs | ${badge.detail} | ${pass(badge.ok)} |`);
  if (rendered) {
    L.push(
      `| Best Rate badge = argmax(APY − round-trip cost) | exactly 1 badged row, = argmax | ${rendered.detail} | ${pass(rendered.ok)} |`,
    );
  } else {
    L.push(
      "| Best Rate badge = argmax(APY − round-trip cost) | exactly 1 badged row, = argmax | not checked this run — pass `--compare-json <dump>` | — |",
    );
  }
  L.push("");
  L.push(
    `> The badge ranks **leveraged APY minus the Aquarius round-trip cost of entering and exiting** ` +
      `(2 × impact, over a ${HOLD_YEARS}-year hold). Half that input is Blend reserve data, which this script does ` +
      `not query — so a standalone run verifies the Aquarius half (the impact every cost is derived from) and the ` +
      `ranking itself requires \`--compare-json <dump of the rendered rows>\`. ` +
      `${rendered ? "This run had one, so the row above is the real end-to-end check." : "Without one, the ranking is covered only by `frontend/test/compare_metrics.test.ts`."}`,
  );
  L.push("");
  L.push("## Per-pair detail");
  L.push("");
  L.push(
    "| Pair | Rate (USDC per 1) | Re-quote | Drift (bps) | Round-trip (bps) | 10× depth | Impact @ notional (bps) | Hops |",
  );
  L.push("| --- | ---: | ---: | ---: | ---: | :---: | ---: | ---: |");
  // Mark whichever answer is authoritative for this run: the row the UI actually
  // Only a dump can say which row is badged — the ranking needs levApy, which
  // this script does not have. Without one, nothing is marked rather than
  // marking a row on a guess.
  const bestSym = rendered?.symbol;
  for (const r of results) {
    if (r.rate == null) {
      L.push(`| ${r.symbol}/USDC | no route | — | — | — | — | — | — |`);
      continue;
    }
    // Mark the badged pair inline so the verdict is legible without re-deriving it.
    const impact =
      r.impactBps == null
        ? "—"
        : `${r.impactBps.toFixed(1)}${bestSym && r.symbol === bestSym ? " **← badged on screen**" : ""}`;
    L.push(
      `| ${r.symbol}/USDC | ${fmt(r.rate)} | ${r.rate2 == null ? "—" : fmt(r.rate2)} | ` +
        `${r.stabilityBps == null ? "—" : r.stabilityBps.toFixed(1)} | ` +
        `${r.roundTripBps == null ? "—" : r.roundTripBps.toFixed(0)} | ` +
        `${r.depthOk == null ? "—" : r.depthOk ? "yes" : "no"} | ${impact} | ${r.hops ?? "—"} |`,
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
    "- `frontend/src/views/compare.ts` renders the **DEX Rate** column from `aquariusRateWithImpact(asset → USDC)` — the same `find-path` call and the same 1-unit probe measured above.",
  );
  L.push(
    `- The **Best Rate** badge marks the row with the highest leveraged APY **after trading costs**: \`levApy − 2 × impact\`, where impact is the price impact at ~${IMPACT_NOTIONAL.toLocaleString("en-US")} USDC of notional measured in the table below, doubled for entry + exit and spread over a ${HOLD_YEARS}-year hold (\`netOfCostApy\` → \`bestRateRowIndex\` in \`frontend/src/compare_metrics.ts\`).`,
  );
  L.push(
    "- Why net of cost rather than the raw rate or the cheapest route: the raw `dexRate` is USDC per unit, so its argmax is just the highest-denominated token; and the cheapest route to trade is not what a user on a leveraged-lending screen is shopping for. A 1497 bps round trip genuinely destroys a 6% yield, while a 0.3 bps one is irrelevant next to a 26% one.",
  );
  L.push(
    "- The ranking is **row-level**, not asset-level: one asset in three pools shares an Aquarius rate but has three different APYs, so the badge lands on a specific row for a reason rather than by tiebreak.",
  );
  L.push(
    "- USDC rows carry a real zero cost (no swap needed in either direction) and compete on APY like any other row.",
  );
  L.push(
    "- The ★ in the Rank column is a *different* marker: rank 1 by leveraged APY before costs (`bestRowIndex`). It coincides with the badge whenever trading cost does not change the winner, and diverges exactly when it does.",
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

  // Always runs: this is the Aquarius half of the badge input.
  const badge = checkImpactInputs(results);

  // Optional end-to-end check: what the UI actually badged vs the live argmin.
  let rendered: BadgeCheck | null = null;
  const dump = arg("--compare-json");
  if (dump) {
    rendered = checkBadgeRendered(JSON.parse(readFileSync(resolve(dump), "utf8")) as CompareRowDump[], results);
  }

  const md = render(results, badge, rendered, !fixture);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, md, "utf8");
  process.stderr.write(`\nwrote ${OUT_FILE}\n`);

  const priced = results.filter((r) => r.rate != null).length;
  if (!fixture && priced < MIN_PAIRS) {
    process.stderr.write(`FAIL: only ${priced} priced pairs, need >= ${MIN_PAIRS}\n`);
    process.exitCode = 1;
  }
  // A wrong badge is an acceptance failure, not a footnote.
  if (!badge.ok || (rendered && !rendered.ok)) {
    process.stderr.write(`FAIL: badge check — ${!badge.ok ? badge.detail : rendered?.detail}\n`);
    process.exitCode = 1;
  }
}

void main();
