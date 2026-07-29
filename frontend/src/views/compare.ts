import "./compare.css";
/**
 * Compare screen — ranks every pool×asset by leveraged net APY.
 *
 * No wallet needed. Data-wiring ported from /tmp/old-main.ts
 * (compareLevApy / compareSortRows / renderCompareTable / renderCompareView):
 *   - reserves per pool via fetchAllReserves
 *   - carry-optimal leverage + levApy at the same minHF the Trade form uses
 *   - indicative "DEX Rate" (1 unit → USDC) via aquariusPriceResult
 *   - net-supply-APR history sparkline via fetchSnapshotSeries
 * The data/service layer is reused unchanged; only the rendering is new.
 */
import { el, on, Badge, Tooltip, Sparkline, type Child } from "../ui";
import {
  getKnownPools,
  getPoolAssets,
  fetchAllReserves,
  maxLeverageFor,
  type ReserveStats,
  type AssetInfo,
} from "../blend";
import { aquariusPriceResult, type AquariusStatus } from "../aquarius";
import { fetchSnapshotSeriesMulti, type SnapshotPoint } from "../history";
import {
  bestRowIndex,
  compareSortRows,
  deltaOverHours,
  FLAT_EPS_PCT,
  pctChangeOverHours,
  resample,
  trendOf,
  trendOfDelta,
  windowSlice,
  type Trend,
} from "../compare_metrics";
import { getState } from "../app/state";
import { t } from "../i18n";

// ── Helpers ported from old-main.ts ──────────────────────────────────────────

/** Continuous-compounding APR → APY, in %. Copied verbatim from old-main.ts. */
const aprToApy = (apr: number) => (Math.exp(apr / 100) - 1) * 100;

// Compare uses the SAME health-factor floor as the Trade form so its "Max Lev"
// and ranking reflect the position a user can actually open. minHF tightens in
// expert mode, exactly like main.ts's minHF().
const MIN_HF_NORMAL = 1.01;
const MIN_HF_EXPERT = 1.00001;
function minHF(): number {
  return getState().expert ? MIN_HF_EXPERT : MIN_HF_NORMAL;
}

interface CompareRow {
  poolName: string;
  poolId: string;
  asset: AssetInfo;
  baseApy: number; // aprToApy(netSupplyApr)
  safeLev: number; // max leverage at minHF() — matches the trade form
  levApy: number; // net APY at the carry-optimal leverage
  dexRate: number | null; // indicative 1 unit → USDC; null = no rate
  dexStatus: AquariusStatus; // why there is no rate: no_route vs Aquarius down
  series: SnapshotPoint[]; // net supply APR history within the window
  dexSeries: SnapshotPoint[]; // Aquarius rate history (dex_rate) within the window
}

/** Carry-optimal leverage + the net APY it yields at current pool rates.
 *  Max leverage uses minHF() — identical to the trade form's slider ceiling.
 *  (maxLeverageFor caps at 100.) Ported from old-main.ts compareLevApy(). */
function compareLevApy(rs: ReserveStats): { safeLev: number; levApy: number } {
  const safeLev = Math.max(1, maxLeverageFor(rs.cFactor, rs.lFactor, minHF()));
  const carry = rs.netSupplyApr - rs.netBorrowCost; // marginal yield per extra leverage unit
  const effLev = carry > 0 ? safeLev : 1; // negative carry → no leverage
  const levApy = aprToApy(rs.netSupplyApr * effLev - rs.netBorrowCost * (effLev - 1));
  return { safeLev, levApy };
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

// ── Window resampling (mirrors CompareScreen.jsx) ─────────────────────────────

type Win = "24H" | "7D" | "30D" | "1Y";
const WIN_DAYS: Record<Win, number> = { "24H": 1, "7D": 7, "30D": 30, "1Y": 365 };
const WIN_POINTS: Record<Win, number> = { "24H": 12, "7D": 7, "30D": 14, "1Y": 26 };
const WIN_LABEL: Record<Win, string> = { "24H": "24h", "7D": "7d", "30D": "30d", "1Y": "1y" };

const ARROW: Record<Trend, string> = { up: "▲", down: "▼", flat: "—" };

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

// ── Table rendering ───────────────────────────────────────────────────────────

function th(label: string, tip: string, align: "l" | "r" | "c"): HTMLElement {
  return el("th", { class: `tl-cmp__th tl-cmp__th--${align}`, scope: "col" }, [
    el("span", { class: "tl-cmp__th-inner" }, [label, Tooltip({ text: tip })]),
  ]);
}

function stateRow(text: string): HTMLElement {
  return el("tr", {}, [el("td", { class: "tl-cmp__state", colspan: "7" }, [text])]);
}

function dataRow(r: CompareRow, idx: number, best: boolean, win: Win): HTMLElement {
  const cls = ["tl-cmp__row"];
  if (best) cls.push("is-best");

  // Sparkline is scoped to the selected chip; the 24h/7d arrows are fixed
  // windows so the deltas stay comparable across rows whatever chip is active.
  const vals = windowSlice(r.series, WIN_DAYS[win]).map((p) => p.val);
  const trend = trendOf(vals);
  const sparkData = resample(vals, WIN_POINTS[win]);
  const winLabel = WIN_LABEL[win];
  const d24 = deltaOverHours(r.series, 24);
  const d7d = deltaOverHours(r.series, 24 * 7);

  const levCls = r.levApy >= 0 ? "tl-cmp__lev--pos" : "tl-cmp__lev--neg";
  const levTxt = (r.levApy >= 0 ? "+" : "") + r.levApy.toFixed(2) + "%";

  const assetChildren: Child[] = [
    el("span", { class: "tl-cmp__sym" }, [r.asset.symbol]),
    el("span", { class: "tl-cmp__pool" }, [r.poolName]),
  ];
  if (best) {
    assetChildren.push(Badge({ tone: "success", children: tx("compare.bestRate", "Best Rate") }));
    assetChildren.push(Tooltip({ text: "Highest leveraged net APY across all pools and assets right now." }));
  }

  const rankCell = best
    ? el("td", { class: "tl-cmp__td tl-cmp__mono tl-cmp__rank" }, [
        el("span", { class: "tl-cmp__star", "aria-hidden": "true" }, ["★"]),
        el("span", { class: "sr-only" }, ["Rank 1"]),
      ])
    : el("td", { class: "tl-cmp__td tl-cmp__mono tl-cmp__rank" }, [String(idx + 1)]);

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
          title: `${winLabel} trend: ${trend}`,
        })
      : el("span", { class: "tl-cmp__muted" }, ["—"]);

  return el("tr", { class: cls.join(" ") }, [
    rankCell,
    el("td", { class: "tl-cmp__td" }, [el("span", { class: "tl-cmp__asset-cell" }, assetChildren)]),
    el("td", { class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__base" }, [r.baseApy.toFixed(2) + "%"]),
    el("td", { class: `tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__lev ${levCls}` }, [levTxt]),
    el("td", { class: "tl-cmp__td tl-cmp__td--r tl-cmp__mono tl-cmp__max" }, [r.safeLev.toFixed(1) + "×"]),
    dexCell,
    el("td", { class: "tl-cmp__td" }, [
      el("span", { class: "tl-cmp__trend-cell" }, [
        spark,
        el("span", { class: "tl-cmp__deltas" }, [deltaArrow("24h", d24), deltaArrow("7d", d7d)]),
      ]),
    ]),
  ]);
}

/** Build the screen. Renders immediately with a loading row, fills async. */
export function compareScreen(): HTMLElement {
  const root = el("div", { class: "tl-cmp" });

  let win: Win = "30D";
  const rows: CompareRow[] = [];
  let loading = true;

  const tbody = el("tbody");

  const renderBody = () => {
    if (rows.length === 0) {
      tbody.replaceChildren(
        stateRow(loading ? tx("compare.loading", "Loading pools…") : tx("compare.empty", "No pools available.")),
      );
      return;
    }
    const ranked = compareSortRows(rows);
    const bestIdx = bestRowIndex(ranked);
    tbody.replaceChildren(...ranked.map((r, i) => dataRow(r, i, i === bestIdx, win)));
  };

  // Header window chips → re-render the sparklines (scopes trend, not columns).
  const chips = (["24H", "7D", "30D", "1Y"] as Win[]).map((w) =>
    on(el("button", { class: `tl-cmp__chip${w === win ? " is-active" : ""}`, type: "button" }, [w]), "click", () => {
      win = w;
      for (const c of chipEls) c.classList.toggle("is-active", c.textContent === w);
      renderBody();
    }),
  );
  const chipEls = chips;

  const head = el("div", { class: "tl-cmp__head" }, [
    el("div", {}, [
      el("h1", { class: "tl-cmp__h1" }, [tx("compare.title", "Compare Pools")]),
      el("p", { class: "tl-cmp__sub" }, [
        tx(
          "compare.subtitle",
          "Live net APY across every Blend pool & asset, ranked by best leveraged yield. DEX rate sourced across Stellar DEXes. No wallet needed.",
        ),
      ]),
    ]),
    el("div", { class: "tl-cmp__win" }, [
      el("span", { class: "tl-cmp__win-label" }, ["History"]),
      el("div", { class: "tl-cmp__chips" }, chips),
    ]),
  ]);

  const table = el("table", { class: "tl-cmp__table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { class: "tl-cmp__th tl-cmp__th--l tl-cmp__rank", scope: "col" }, [tx("compare.col.rank", "#")]),
        el("th", { class: "tl-cmp__th tl-cmp__th--l", scope: "col" }, [tx("compare.col.poolAsset", "Pool / Asset")]),
        th(tx("compare.col.baseApy", "Base APY"), "The pool’s net supply yield before any leverage is applied.", "r"),
        th(
          tx("compare.col.levApy", "Leveraged APY"),
          "Net APY at the carry-optimal leverage for this pool/asset — the looped yield you could actually achieve, after borrow costs.",
          "r",
        ),
        th(
          tx("compare.col.maxLev", "Max Lev"),
          "The highest leverage allowed at the minimum Health Factor — the same ceiling the Trade slider uses.",
          "r",
        ),
        th(
          tx("compare.col.aquaRate", "DEX Rate"),
          "Live Aquarius quote for swapping 1 unit of this asset → USDC, routed across the aggregated Stellar DEX surface. The 24h / 7d figures are the rate's movement over those windows, from the Turbolong snapshot service.",
          "r",
        ),
        th(
          tx("compare.col.trend", "Trend"),
          "Sparkline: net supply APR over the selected window (24H / 7D / 30D / 1Y). Arrows: the 24h and 7d change in net supply APR, in percentage points, from the Turbolong snapshot service.",
          "c",
        ),
      ]),
    ]),
    tbody,
  ]);

  const foot = el("p", { class: "tl-cmp__foot" }, [
    tx(
      "compare.foot",
      "Max Lev and Leveraged APY use the same minimum health factor as the trade form, so they match the position you can actually open; actual results depend on rate drift and gas. DEX rate is a live indicative quote for 1 unit → USDC from Aquarius' routing API across the aggregated Stellar DEX surface, with its 24h/7d movement from the snapshot service; when Aquarius is unreachable the column reads “unavailable” and the pool figures are unaffected. Trend arrows show the 24h and 7d change in net supply APR, in percentage points, from the Turbolong snapshot service.",
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
        const { safeLev, levApy } = compareLevApy(rs);
        rows.push({
          poolName: pool.name,
          poolId: pool.id,
          asset: rs.asset,
          baseApy: aprToApy(rs.netSupplyApr),
          safeLev,
          levApy,
          dexRate: null,
          dexStatus: "no_route",
          series: [],
          dexSeries: [],
        });
      }
      renderBody();
    }
    loading = false;
    renderBody();

    // 2. Enrich each row with a DEX rate + history sparkline, all in parallel.
    await Promise.allSettled(
      rows.map(async (r) => {
        const sym = r.asset.symbol.toUpperCase();
        const tasks: Promise<unknown>[] = [];
        if (sym === "USDC") {
          r.dexRate = 1; // identity — no route needed
          r.dexStatus = "ok";
        } else if (usdc && r.asset.id !== usdc) {
          tasks.push(
            aquariusPriceResult(r.asset.id, usdc)
              .then(({ price, status }) => {
                r.dexRate = price;
                r.dexStatus = status;
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
          fetchSnapshotSeriesMulti(r.poolId, r.asset.symbol, ["net_supply_apr", "dex_rate"] as const, limit)
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
