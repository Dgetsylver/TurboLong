import "./compare.css";
/**
 * Compare screen (A9) — cross-pool net-APY ranking at multiple leverage brackets.
 *
 * Two data sources, one per axis:
 *   - Aquarius (aquarius.ts) → indicative "DEX Rate" (1 unit → USDC) + the price
 *     impact at size that the "Best Rate" badge nets off the yield, via
 *     aquariusRateWithImpact
 *   - the T2 snapshot service (history.ts) → net-supply-APR and dex_rate time
 *     series, which drive the 7d/30d/1y per-asset APY chart, the 24h/7d trend
 *     arrows and the 24h/7d DEX-rate movement
 *
 * No wallet is required: reserves are fetched with an empty user address, so the
 * whole screen works for an anonymous visitor.
 *
 * The ranking/window/geometry logic lives in ../compare_model and the Best Rate /
 * delta maths in ../compare_metrics (both pure, unit-tested in
 * test/compare.test.ts and test/compare_metrics.test.ts); this file is rendering
 * and data-wiring only.
 */
import { el, on, Badge, Tooltip, Sparkline, ApyChart, type Child } from "../ui";
import {
  getKnownPools,
  getPoolAssets,
  fetchAllReserves,
  maxLeverageFor,
  type ReserveStats,
} from "../blend";
import { aquariusRateWithImpact, IMPACT_NOTIONAL, type AquariusStatus } from "../aquarius";
import { fetchSnapshotSeriesMulti, type SnapshotPoint } from "../history";
import {
  ARROW,
  BRACKETS,
  WINS,
  WIN_DAYS,
  WIN_LABEL,
  WIN_POINTS,
  axisTicks,
  baseApy,
  bracketLabel,
  rankRows,
  resample,
  sliceWindow,
  trendDelta,
  trendOf,
  type Bracket,
  type CompareRowData,
  type RankedRow,
  type Win,
} from "../compare_model";
import {
  bestRateRowIndex,
  deltaOverHours,
  FLAT_EPS_PCT,
  HOLD_YEARS,
  netOfCostApy,
  pctChangeOverHours,
  roundTripCostPp,
  trendOfDelta,
} from "../compare_metrics";
import { getState } from "../app/state";
import { t } from "../i18n";

// Compare uses the SAME health-factor floor as the Trade form so its "Max Lev"
// and ranking reflect the position a user can actually open. minHF tightens in
// expert mode, exactly like main.ts's minHF().
const MIN_HF_NORMAL = 1.01;
const MIN_HF_EXPERT = 1.00001;
function minHF(): number {
  return getState().expert ? MIN_HF_EXPERT : MIN_HF_NORMAL;
}

/** The ranked row shape plus what Aquarius said about it. */
interface CompareRow extends CompareRowData {
  dexStatus: AquariusStatus; // why there is no rate: no_route vs Aquarius down
  dexImpactBps: number | null; // Aquarius price impact at IMPACT_NOTIONAL; drives the badge
  dexSeries: SnapshotPoint[]; // Aquarius rate history (dex_rate) within the window
}

/** First USDC asset id across all known pools, for the DEX-rate quote target. */
function usdcAssetId(): string | null {
  for (const p of getKnownPools()) {
    for (const a of getPoolAssets(p)) {
      if (a.symbol.toUpperCase() === "USDC") return a.id;
    }
  }
  return null;
}

/** One labelled 24h/7d delta arrow — "24h ▲ +0.12". */
function deltaArrow(label: string, d: number | null): HTMLElement {
  if (d == null) {
    return el("span", { class: "tl-cmp__delta" }, [
      el("span", { class: "tl-cmp__delta-lbl" }, [label]),
      el("span", { class: "tl-cmp__arrow tl-cmp__arrow--flat" }, ["—"]),
    ]);
  }
  const tr = trendOfDelta(d);
  const sign = d > 0 ? "+" : "";
  return el("span", { class: "tl-cmp__delta", title: `${label} change in net supply APR: ${sign}${d.toFixed(2)} pp` }, [
    el("span", { class: "tl-cmp__delta-lbl" }, [label]),
    el("span", { class: `tl-cmp__arrow tl-cmp__arrow--${tr}` }, [ARROW[tr]]),
    el("span", { class: `tl-cmp__delta-val tl-cmp__delta-val--${tr}` }, [`${sign}${d.toFixed(2)}`]),
  ]);
}

/**
 * 24h / 7d DEX-rate movement, from the `dex_rate` column of the T2 snapshot
 * series. Percent (not percentage points) — these are prices. Renders nothing
 * at all when neither window has enough history, so a freshly-migrated database
 * shows a clean rate rather than two empty dashes under every row.
 */
function rateTrend(dexSeries: SnapshotPoint[]): HTMLElement | null {
  const p24 = pctChangeOverHours(dexSeries, 24);
  const p7d = pctChangeOverHours(dexSeries, 24 * 7);
  if (p24 == null && p7d == null) return null;

  const one = (label: string, p: number | null): Child => {
    if (p == null) return "";
    const tr = trendOfDelta(p, FLAT_EPS_PCT);
    const sign = p > 0 ? "+" : "";
    return el(
      "span",
      { class: "tl-cmp__rate-delta", title: `${label} change in the Aquarius rate: ${sign}${p.toFixed(2)}%` },
      [
        el("span", { class: "tl-cmp__delta-lbl" }, [label]),
        el("span", { class: `tl-cmp__arrow tl-cmp__arrow--${tr}` }, [ARROW[tr]]),
        el("span", { class: `tl-cmp__delta-val tl-cmp__delta-val--${tr}` }, [`${sign}${p.toFixed(2)}%`]),
      ],
    );
  };
  return el("span", { class: "tl-cmp__rate-trend" }, [one("24h", p24), one("7d", p7d)]);
}

// ── i18n with literal fallback (t returns the key if missing) ─────────────────
const tx = (key: string, fallback: string) => {
  const v = t(key);
  return v === key ? fallback : v;
};

const COLSPAN = "8";

// ── Table rendering ───────────────────────────────────────────────────────────

function th(label: string, tip: string, align: "l" | "r" | "c"): HTMLElement {
  return el("th", { class: `tl-cmp__th tl-cmp__th--${align}`, scope: "col" }, [
    el("span", { class: "tl-cmp__th-inner" }, [label, Tooltip({ text: tip })]),
  ]);
}

function stateRow(text: string): HTMLElement {
  return el("tr", {}, [el("td", { class: "tl-cmp__state", colspan: COLSPAN }, [text])]);
}

function chipRow(label: string, chips: HTMLElement[], extraClass = ""): HTMLElement {
  return el("div", { class: `tl-cmp__win ${extraClass}`.trim() }, [
    el("span", { class: "tl-cmp__win-label" }, [label]),
    el("div", { class: "tl-cmp__chips" }, chips),
  ]);
}

/** Expanded detail row: the full 7d/30d/1y APY chart for one pool×asset. */
function chartRow(rr: RankedRow<CompareRowData>, win: Win): HTMLElement {
  const r = rr.row;
  const windowed = sliceWindow(r.series, win);
  const vals = windowed.map((p) => p.val);
  const trend = trendOf(vals);
  const delta = trendDelta(vals);

  const chart =
    vals.length >= 2
      ? ApyChart({
          data: resample(vals, WIN_POINTS[win]),
          tone: trend,
          ticks: axisTicks(windowed, 3),
          title: `${r.assetSymbol} on ${r.poolName}: net supply APY over the last ${WIN_LABEL[win]}`,
        })
      : el("p", { class: "tl-cmp__chart-empty" }, [
          tx("compare.chart.empty", "Not enough history yet for this window."),
        ]);

  const meta = el("div", { class: "tl-cmp__chart-meta" }, [
    el("span", { class: "tl-cmp__chart-title" }, [
      `${r.assetSymbol} · ${r.poolName} — ${tx("compare.chart.label", "net supply APY")} (${WIN_LABEL[win]})`,
    ]),
    vals.length >= 2 &&
      el("span", { class: `tl-cmp__chart-delta tl-cmp__arrow--${trend}` }, [
        `${ARROW[trend]} ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} pp`,
      ]),
  ]);

  return el("tr", { class: "tl-cmp__chartrow" }, [
    el("td", { class: "tl-cmp__chartcell", colspan: COLSPAN }, [
      el("div", { class: "tl-cmp__chartwrap" }, [meta, chart]),
    ]),
  ]);
}

interface RowCallbacks {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * One table row. Rank 1 is the APY leader at the selected bracket (★ + row
 * highlight); `bestRate` is the Aquarius execution leader (the "Best Rate"
 * badge). They are separate flags because they answer different questions and
 * often land on different rows — see rankRows in compare_model.ts and
 * bestRateRowIndex in compare_metrics.ts.
 */
function dataRow(rr: RankedRow<CompareRow>, win: Win, bestRate: boolean, cb: RowCallbacks): HTMLElement {
  const r = rr.row;
  const rankOne = rr.rank === 1;
  const cls = ["tl-cmp__row"];
  if (rankOne) cls.push("is-best");
  if (cb.expanded) cls.push("is-open");

  // Sparkline is scoped to the selected chip; the 24h/7d arrows are fixed
  // windows so the deltas stay comparable across rows whatever chip is active.
  const vals = sliceWindow(r.series, win).map((p) => p.val);
  const trend = trendOf(vals);
  const sparkData = resample(vals, Math.min(WIN_POINTS[win], 24));
  const d24 = deltaOverHours(r.series, 24);
  const d7d = deltaOverHours(r.series, 24 * 7);

  const { apy, lev, capped } = rr.result;
  const levCls = apy >= 0 ? "tl-cmp__lev--pos" : "tl-cmp__lev--neg";
  const levTxt = (apy >= 0 ? "+" : "") + apy.toFixed(2) + "%";

  const assetChildren: Child[] = [
    el("span", { class: "tl-cmp__sym" }, [r.assetSymbol]),
    el("span", { class: "tl-cmp__pool" }, [r.poolName]),
  ];
  if (bestRate) {
    // State the arithmetic and the assumption. A bare "Best Rate" next to a
    // number that silently nets off a cost would be the misleading version.
    const bps = r.dexImpactBps ?? 0;
    const cost = roundTripCostPp(bps);
    const net = netOfCostApy(apy, bps);
    const holdTxt = HOLD_YEARS === 1 ? "a 1-year hold" : `a ${HOLD_YEARS}-year hold`;
    assetChildren.push(Badge({ tone: "success", children: tx("compare.bestRate", "Best Rate") }));
    assetChildren.push(
      Tooltip({
        text:
          `Best return after trading costs: ${apy.toFixed(2)}% net APY at ${lev.toFixed(1)}× less ${cost.toFixed(2)}pp to enter ` +
          `and exit via the Stellar DEX (Aquarius quotes ${bps.toFixed(1)} bps of price impact each way on a ` +
          `~$${IMPACT_NOTIONAL.toLocaleString("en-US")} trade) = ${net.toFixed(2)}% net, assuming ${holdTxt} ` +
          `from and back to USDC. Highest of any row at the selected leverage bracket.`,
      }),
    );
  }

  const rankCell = rankOne
    ? el("td", { class: "tl-cmp__td tl-cmp__mono tl-cmp__rank" }, [
        el("span", { class: "tl-cmp__star", "aria-hidden": "true" }, ["★"]),
        el("span", { class: "sr-only" }, ["Rank 1"]),
      ])
    : el("td", { class: "tl-cmp__td tl-cmp__mono tl-cmp__rank" }, [String(rr.rank)]);

  // A capped row can't reach the selected bracket — show the leverage it does
  // reach, so the APY beside it is never read as achievable at the bracket.
  const atCell = el("td", { class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__at" }, [
    el("span", { class: capped ? "tl-cmp__at-capped" : "" }, [lev.toFixed(1) + "×"]),
    capped && Tooltip({ text: `Capped: this reserve tops out at ${lev.toFixed(1)}× at the minimum health factor.` }),
  ]);

  // No rate has two very different meanings — say which. See
  // docs/aquarius-rate-fallback.md for the documented degraded path.
  const dexCell =
    r.dexRate == null
      ? el(
          "td",
          {
            class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__muted",
            title:
              r.dexStatus === "unreachable"
                ? "Aquarius routing API is unreachable — rate comparison is temporarily unavailable. Pool APYs above are unaffected."
                : "Aquarius has no route for this pair right now.",
          },
          [r.dexStatus === "unreachable" ? tx("compare.dexDown", "unavailable") : tx("compare.dexNoRoute", "no route")],
        )
      : el("td", { class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__rate" }, [
          el("span", { class: "tl-cmp__rate-cell" }, [
            el("span", {}, [r.dexRate.toFixed(4)]),
            rateTrend(r.dexSeries) ?? "",
          ]),
        ]);

  const spark =
    sparkData.length >= 2
      ? Sparkline({
          data: sparkData,
          width: 56,
          height: 18,
          tone: trend,
          title: `${WIN_LABEL[win]} trend: ${trend}`,
        })
      : el("span", { class: "tl-cmp__muted" }, ["—"]);

  const toggle = on(
    el(
      "button",
      {
        class: "tl-cmp__toggle",
        type: "button",
        "aria-expanded": cb.expanded ? "true" : "false",
        "aria-label": `${cb.expanded ? "Hide" : "Show"} ${WIN_LABEL[win]} APY chart for ${r.assetSymbol} on ${r.poolName}`,
      },
      [el("span", { class: "tl-cmp__toggle-icon", "aria-hidden": "true" }, [cb.expanded ? "▾" : "▸"])],
    ),
    "click",
    cb.onToggle,
  );

  return el("tr", { class: cls.join(" ") }, [
    rankCell,
    el("td", { class: "tl-cmp__td" }, [el("span", { class: "tl-cmp__asset-cell" }, assetChildren)]),
    el("td", { class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__base" }, [baseApy(r).toFixed(2) + "%"]),
    el("td", { class: `tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__lev ${levCls}` }, [levTxt]),
    atCell,
    el("td", { class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__max" }, [r.safeLev.toFixed(1) + "×"]),
    dexCell,
    el("td", { class: "tl-cmp__td" }, [
      el("span", { class: "tl-cmp__trend-cell" }, [
        spark,
        el("span", { class: "tl-cmp__deltas" }, [deltaArrow("24h", d24), deltaArrow("7d", d7d)]),
        toggle,
      ]),
    ]),
  ]);
}

/** Build the screen. Renders immediately with a loading row, fills async. */
export function compareScreen(): HTMLElement {
  const root = el("div", { class: "tl-cmp" });

  let win: Win = "30D";
  let bracket: Bracket = "max";
  const rows: CompareRow[] = [];
  /** Expanded charts, keyed pool:asset so the set survives a re-rank. */
  const open = new Set<string>();
  let loading = true;

  const rowKey = (r: CompareRowData) => `${r.poolId}:${r.assetId}`;

  const tbody = el("tbody");

  const renderBody = () => {
    if (rows.length === 0) {
      tbody.replaceChildren(
        stateRow(loading ? tx("compare.loading", "Loading pools…") : tx("compare.empty", "No pools available.")),
      );
      return;
    }
    const ranked = rankRows(rows, bracket);
    // The badge nets each row's APY at the selected bracket against its Aquarius
    // round-trip cost. Ranked order matters: bestRateRowIndex breaks
    // execution-quality ties toward the earlier (higher-APY) row.
    const bestRateIdx = bestRateRowIndex(
      ranked.map((rr) => ({ levApy: rr.result.apy, dexImpactBps: rr.row.dexImpactBps })),
    );
    const out: HTMLElement[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const rr = ranked[i];
      const key = rowKey(rr.row);
      const expanded = open.has(key);
      out.push(
        dataRow(rr, win, i === bestRateIdx, {
          expanded,
          onToggle: () => {
            if (open.has(key)) open.delete(key);
            else open.add(key);
            renderBody();
          },
        }),
      );
      if (expanded) out.push(chartRow(rr, win));
    }
    tbody.replaceChildren(...out);
  };

  // Window chips scope the history: charts and sparklines read the sliced
  // series, so "7D" really means the last seven days. The 24h/7d arrows are
  // fixed windows and do not move with the chip.
  const winChips = WINS.map((w) =>
    on(
      el(
        "button",
        {
          class: `tl-cmp__chip${w === win ? " is-active" : ""}`,
          type: "button",
          "aria-pressed": w === win ? "true" : "false",
        },
        [w],
      ),
      "click",
      () => {
        win = w;
        for (const c of winChips) {
          const active = c.textContent === w;
          c.classList.toggle("is-active", active);
          c.setAttribute("aria-pressed", active ? "true" : "false");
        }
        renderBody();
      },
    ),
  );

  // Bracket chips re-rank the whole table at a fixed leverage, so a user can
  // see which pool wins at 2× versus at the ceiling — they rarely agree.
  const brChips = BRACKETS.map((b) => {
    const label = bracketLabel(b);
    return on(
      el(
        "button",
        {
          class: `tl-cmp__chip${b === bracket ? " is-active" : ""}`,
          type: "button",
          "aria-pressed": b === bracket ? "true" : "false",
        },
        [label],
      ),
      "click",
      () => {
        bracket = b;
        for (let i = 0; i < brChips.length; i++) {
          const active = BRACKETS[i] === b;
          brChips[i].classList.toggle("is-active", active);
          brChips[i].setAttribute("aria-pressed", active ? "true" : "false");
        }
        levHead.textContent = tx("compare.col.netApy", "Net APY") + ` @ ${label}`;
        renderBody();
      },
    );
  });

  const levHead = el("span", { class: "tl-cmp__th-label" }, [
    tx("compare.col.netApy", "Net APY") + ` @ ${bracketLabel(bracket)}`,
  ]);

  const head = el("div", { class: "tl-cmp__head" }, [
    el("div", {}, [
      el("h1", { class: "tl-cmp__h1" }, [tx("compare.title", "Compare Pools")]),
      el("p", { class: "tl-cmp__sub" }, [
        tx(
          "compare.subtitle",
          "Live net APY across every Blend pool & asset, ranked at the leverage bracket you pick. DEX rate sourced across Stellar DEXes. No wallet needed.",
        ),
      ]),
    ]),
    el("div", { class: "tl-cmp__controls" }, [
      chipRow(tx("compare.leverage", "Leverage"), brChips),
      chipRow(tx("compare.history", "History"), winChips),
    ]),
  ]);

  const table = el("table", { class: "tl-cmp__table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { class: "tl-cmp__th tl-cmp__th--l tl-cmp__rank", scope: "col" }, [tx("compare.col.rank", "#")]),
        el("th", { class: "tl-cmp__th tl-cmp__th--l", scope: "col" }, [tx("compare.col.poolAsset", "Pool / Asset")]),
        th(tx("compare.col.baseApy", "Base APY"), "The pool’s net supply yield before any leverage is applied.", "r"),
        el("th", { class: "tl-cmp__th tl-cmp__th--r", scope: "col" }, [
          el("span", { class: "tl-cmp__th-inner" }, [
            levHead,
            Tooltip({
              text: "Net APY if you hold the loop at the selected leverage bracket, after borrow costs. “Max” is the carry-optimal leverage — 1× when the carry is negative.",
            }),
          ]),
        ]),
        th(
          tx("compare.col.at", "At Lev"),
          "The leverage this row is actually evaluated at. Below the bracket when the reserve's collateral factor won't reach it.",
          "r",
        ),
        th(
          tx("compare.col.maxLev", "Max Lev"),
          "The highest leverage allowed at the minimum Health Factor — the same ceiling the Trade slider uses.",
          "r",
        ),
        th(
          tx("compare.col.aquaRate", "DEX Rate"),
          `Live Aquarius quote for swapping 1 unit of this asset → USDC, routed across the aggregated Stellar DEX surface. The 24h / 7d figures are the rate's movement over those windows, from the Turbolong snapshot service. The “Best Rate” badge marks the row with the highest net APY at the selected bracket after the cost of entering and exiting at these rates (~$${IMPACT_NOTIONAL.toLocaleString("en-US")} trade, ${HOLD_YEARS}-year hold).`,
          "r",
        ),
        th(
          tx("compare.col.trend", "Trend"),
          "Sparkline: net supply APR over the selected window (7D / 30D / 1Y); ▸ opens the full chart. Arrows: the 24h and 7d change in net supply APR, in percentage points, from the Turbolong snapshot service.",
          "c",
        ),
      ]),
    ]),
    tbody,
  ]);

  const foot = el("p", { class: "tl-cmp__foot" }, [
    tx(
      "compare.foot",
      "Net APY and Max Lev use the same minimum health factor as the trade form, so they match the position you can actually open; actual results depend on rate drift and gas. Rows whose collateral factor can't reach the selected bracket are ranked at the leverage they do reach. DEX rate is a live indicative quote for 1 unit → USDC from Aquarius' routing API across the aggregated Stellar DEX surface, with its 24h/7d movement from the snapshot service; when Aquarius is unreachable the column reads “unavailable” and the pool figures are unaffected. Charts and sparklines show net supply APY history from the Turbolong snapshot service; the arrows show its 24h and 7d change in percentage points.",
    ),
  ]);

  root.append(head, el("div", { class: "tl-cmp__shell" }, [table]), foot);

  renderBody(); // immediate loading row
  void loadCompare().catch((e) => console.warn("Compare load failed", e));

  // ── async data fill ────────────────────────────────────────────────────────
  async function loadCompare(): Promise<void> {
    const usdc = usdcAssetId();
    // Snapshot fetch limit scales with the widest window we might show.
    const limit = 2000;
    const cutoff = Date.now() - WIN_DAYS["1Y"] * 86_400_000;

    // 1. Reserves per pool (sequential per pool to spare the RPC); render progressively.
    //    The empty user address is deliberate — Compare must work with no wallet.
    for (const pool of getKnownPools()) {
      let reserves: ReserveStats[] = [];
      try {
        reserves = await fetchAllReserves(pool, getState().userAddress ?? "");
      } catch (e) {
        console.warn(`compare: reserves failed for ${pool.name}`, e);
        continue;
      }
      for (const rs of reserves) {
        // Compare ranks LEVERAGED yield. Skip reserves that can't be used as
        // collateral (c_factor = 0) — they can't be looped, and their raw
        // emissions-inflated APY would mis-rank the table.
        if (rs.cFactor <= 0) continue;
        rows.push({
          poolName: pool.name,
          poolId: pool.id,
          assetSymbol: rs.asset.symbol,
          assetId: rs.asset.id,
          netSupplyApr: rs.netSupplyApr,
          netBorrowCost: rs.netBorrowCost,
          safeLev: Math.max(1, maxLeverageFor(rs.cFactor, rs.lFactor, minHF())),
          dexRate: null,
          dexStatus: "no_route",
          dexImpactBps: null,
          series: [],
          dexSeries: [],
        });
      }
      renderBody();
    }
    loading = false;
    renderBody();

    // The rate is a property of the asset, not the pool, and the same asset sits
    // in several pools (XLM is in all three). Memoising per asset id keeps the
    // cost at two Aquarius calls per *distinct* asset rather than two per row.
    const quotes = new Map<string, ReturnType<typeof aquariusRateWithImpact>>();
    const quoteFor = (assetId: string) => {
      let q = quotes.get(assetId);
      if (!q) {
        q = aquariusRateWithImpact(assetId, usdc as string);
        quotes.set(assetId, q);
      }
      return q;
    };

    // 2. Enrich each row with a DEX rate + history series, all in parallel.
    await Promise.allSettled(
      rows.map(async (r) => {
        const sym = r.assetSymbol.toUpperCase();
        const tasks: Promise<unknown>[] = [];
        if (sym === "USDC") {
          r.dexRate = 1; // identity — no route needed
          r.dexStatus = "ok";
          // Badge-eligible at zero cost, and that is not a technicality: the
          // badge ranks yield net of getting in and out from USDC, and a USDC
          // position needs no swap in either direction. It still has to win on
          // APY like any other row.
          r.dexImpactBps = 0;
        } else if (usdc && r.assetId !== usdc) {
          tasks.push(
            quoteFor(r.assetId)
              .then(({ rate, impactBps, status }) => {
                r.dexRate = rate;
                r.dexStatus = status;
                r.dexImpactBps = impactBps;
              })
              .catch(() => {
                r.dexStatus = "unreachable";
              }),
          );
        }
        // APR history and Aquarius rate history are two columns of the same
        // rows — one request, both series. Ticks where Aquarius gave no quote
        // are absent from dexSeries (dex_rate IS NULL), which is what keeps a
        // gap from reading as a rate of zero.
        tasks.push(
          fetchSnapshotSeriesMulti(r.poolId, r.assetSymbol, ["net_supply_apr", "dex_rate"] as const, limit)
            .then((s) => {
              r.series = s.net_supply_apr.filter((p) => p.ts >= cutoff);
              r.dexSeries = s.dex_rate.filter((p) => p.ts >= cutoff);
            })
            .catch(() => {}),
        );
        await Promise.all(tasks);
        renderBody();
      }),
    );
    renderBody();
  }

  return root;
}
