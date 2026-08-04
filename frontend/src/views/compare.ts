import "./compare.css";
/**
 * Compare screen (A9) — cross-pool net-APY ranking at multiple leverage brackets.
 *
 * Two data sources, one per axis:
 *   - Aquarius (aquarius.ts) → indicative "DEX Rate", 1 unit → USDC
 *   - the T2 snapshot service (history.ts) → net-supply-APR time series, which
 *     drives the 7d/30d/1y per-asset APY chart and the trend arrow
 *
 * No wallet is required: reserves are fetched with an empty user address, so the
 * whole screen works for an anonymous visitor.
 *
 * The ranking/window/geometry logic lives in ../compare_model (pure, unit-tested
 * in test/compare.test.ts including the <100 ms chart-render budget); this file
 * is rendering and data-wiring only.
 */
import { el, on, Badge, Tooltip, Sparkline, ApyChart, type Child } from "../ui";
import {
  getKnownPools,
  getPoolAssets,
  fetchAllReserves,
  maxLeverageFor,
  type ReserveStats,
} from "../blend";
import { aquariusPrice } from "../aquarius";
import { fetchSnapshotSeries } from "../history";
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

/** First USDC asset id across all known pools, for the DEX-rate quote target. */
function usdcAssetId(): string | null {
  for (const p of getKnownPools()) {
    for (const a of getPoolAssets(p)) {
      if (a.symbol.toUpperCase() === "USDC") return a.id;
    }
  }
  return null;
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

function dataRow(rr: RankedRow<CompareRowData>, win: Win, cb: RowCallbacks): HTMLElement {
  const r = rr.row;
  const best = rr.rank === 1;
  const cls = ["tl-cmp__row"];
  if (best) cls.push("is-best");
  if (cb.expanded) cls.push("is-open");

  const vals = sliceWindow(r.series, win).map((p) => p.val);
  const trend = trendOf(vals);
  const sparkData = resample(vals, Math.min(WIN_POINTS[win], 24));

  const { apy, lev, capped } = rr.result;
  const levCls = apy >= 0 ? "tl-cmp__lev--pos" : "tl-cmp__lev--neg";
  const levTxt = (apy >= 0 ? "+" : "") + apy.toFixed(2) + "%";

  const assetChildren: Child[] = [
    el("span", { class: "tl-cmp__sym" }, [r.assetSymbol]),
    el("span", { class: "tl-cmp__pool" }, [r.poolName]),
  ];
  if (best) {
    assetChildren.push(Badge({ tone: "success", children: tx("compare.bestRate", "Best Rate") }));
    assetChildren.push(
      Tooltip({ text: "Highest net APY across all pools and assets at the selected leverage bracket." }),
    );
  }

  const rankCell = best
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

  const dexCell =
    r.dexRate == null
      ? el("td", { class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__muted" }, ["n/a"])
      : el("td", { class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__rate" }, [r.dexRate.toFixed(4)]);

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
        el("span", { class: `tl-cmp__arrow tl-cmp__arrow--${trend}` }, [ARROW[trend]]),
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
  const rows: CompareRowData[] = [];
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
    const out: HTMLElement[] = [];
    for (const rr of rankRows(rows, bracket)) {
      const key = rowKey(rr.row);
      const expanded = open.has(key);
      out.push(
        dataRow(rr, win, {
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

  // Window chips scope the history: charts, sparklines and trend arrows all
  // read the sliced series, so "7D" really means the last seven days.
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
          "DEX Rate",
          "Indicative DEX quote for swapping 1 unit of this asset → USDC, routed across Stellar DEXes.",
          "r",
        ),
        th(tx("compare.col.trend", "Trend"), "Net supply APY history over the selected window (7D / 30D / 1Y).", "c"),
      ]),
    ]),
    tbody,
  ]);

  const foot = el("p", { class: "tl-cmp__foot" }, [
    tx(
      "compare.foot",
      "Net APY and Max Lev use the same minimum health factor as the trade form, so they match the position you can actually open; actual results depend on rate drift and gas. Rows whose collateral factor can't reach the selected bracket are ranked at the leverage they do reach. DEX rate is an indicative quote for 1 unit → USDC routed across Stellar DEXes. Charts and trend arrows show net supply APY history from the Turbolong snapshot service.",
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
          series: [],
        });
      }
      renderBody();
    }
    loading = false;
    renderBody();

    // 2. Enrich each row with a DEX rate + history series, all in parallel.
    await Promise.allSettled(
      rows.map(async (r) => {
        const sym = r.assetSymbol.toUpperCase();
        const tasks: Promise<unknown>[] = [];
        if (sym === "USDC") {
          r.dexRate = 1;
        } else if (usdc && r.assetId !== usdc) {
          tasks.push(
            aquariusPrice(r.assetId, usdc)
              .then((v) => {
                r.dexRate = v;
              })
              .catch(() => {}),
          );
        }
        tasks.push(
          fetchSnapshotSeries(r.poolId, r.assetSymbol, "net_supply_apr", limit)
            .then((s) => {
              r.series = s.filter((p) => p.ts >= cutoff);
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
