import "./trade.css";
/**
 * Trade screen — open / adjust / monitor a leveraged Blend loop position, on the
 * V3 design system. View-only rewrite: the data/service layer (blend.ts, history.ts)
 * is REUSED UNCHANGED. The money paths (open / close / add / remove / adjust /
 * claim / claim-and-convert) call the SAME blend.ts builders with the SAME
 * arguments in the SAME order as the original main.ts — see the ported handlers.
 *
 * Pattern mirrors dashboard.screen.ts / vault.ts: render immediately, fill async.
 */
import {
  el,
  on,
  Card,
  Badge,
  Button,
  Input,
  StatCard,
  MetricHero,
  HealthFactor,
  RiskBand,
  LeverageSlider,
  Tooltip,
  Skeleton,
  Sparkline,
  zoneFromHF,
} from "../ui";
import {
  getKnownPools,
  getPoolAssets,
  getActiveNetwork,
  getBlndId,
  fetchAllReserves,
  fetchUserPositions,
  fetchAssetBalance,
  fetchPoolPendingBlnd,
  fetchPositionEvents,
  aggregatePoolAccount,
  projectRates,
  hfForLeverage,
  maxLeverageFor,
  buildApproveXdr,
  buildOpenPositionXdr,
  buildCloseSubmitXdr,
  buildRepayXdr,
  buildWithdrawXdr,
  buildClaimXdr,
  buildIncreaseLeverageXdr,
  buildDecreaseLeverageXdr,
  buildRemoveFundsXdr,
  buildSwapBlndXdr,
  estimateBlndSwap,
  getMissingTrustlines,
  buildTrustlineXdr,
  submitClassicXdr,
  type PoolDef,
  type AssetInfo,
  type ReserveStats,
  type AssetPosition,
  type UserPositions,
  type MissingTrustlineResult,
  type PositionEvent,
} from "../blend";
import { fetchSnapshotSeries } from "../history";
import { getState, subscribe } from "../app/state";
import { signAndSubmit, signAndSubmitClassic } from "../app/wallet";
import { toast, txShow, txStep, txHide } from "../app/chrome";

// ── Formatters ────────────────────────────────────────────────────────────────

const fmt = (n: number, d = 2) =>
  n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const money = (n: number) => "$" + fmt(n, 2);
/** APR (%) → compounded APY (%). Mirrors old-main's aprToApy exactly. */
const aprToApy = (apr: number) => (Math.exp(apr / 100) - 1) * 100;

const MIN_HF_NORMAL = 1.01;
const MIN_HF_EXPERT = 1.00001;
/** Min health factor gate — mirrors old-main's minHF(). */
function minHF(): number {
  return getState().expert ? MIN_HF_EXPERT : MIN_HF_NORMAL;
}

function expertUrl(type: "tx" | "contract", id: string): string {
  const net = getActiveNetwork() === "testnet" ? "testnet" : "public";
  return `https://stellar.expert/explorer/${net}/${type}/${id}`;
}

function relTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Inline label + "?" tooltip (matches the React `lbl` helper). */
function lbl(text: string, tip: string): HTMLElement {
  return el("span", { class: "trade-lbl" }, [text, Tooltip({ text: tip })]);
}

// ── Per-screen mutable state ────────────────────────────────────────────────

type ActionMode = "open" | "adjust" | "add-funds" | "remove-funds";

interface TradeState {
  pool: PoolDef;
  assets: AssetInfo[];
  asset: AssetInfo;
  reserves: ReserveStats[];
  positions: UserPositions;
  balance: number;          // wallet balance of selected asset
  pendingBlnd: number;      // pool-wide pending BLND
  events: PositionEvent[];  // on-chain activity for the selected position
  loading: boolean;
  mode: ActionMode;
  holdDays: number;
}

const EVENT_LABELS: Record<string, string> = {
  open: "Opened position",
  rebalance: "Rebalanced",
  harvest: "Claimed BLND",
  close: "Closed position",
};

// ── Screen ──────────────────────────────────────────────────────────────────

/** Build the Trade view. Renders immediately; fills with live data async. */
export function tradeScreen(): HTMLElement {
  const root = el("div", { class: "trade" });

  const pools = getKnownPools();
  const pool = pools[0];
  const assets = getPoolAssets(pool);

  const ts: TradeState = {
    pool,
    assets,
    asset: assets[0],
    reserves: [],
    positions: { byAsset: new Map() },
    balance: 0,
    pendingBlnd: 0,
    events: [],
    loading: true,
    mode: "open",
    holdDays: 90,
  };

  // Mount points. Selectors / stats / rates / history show even when disconnected
  // (public). The action + position columns are gated on connection.
  const selectorEl = el("div", { class: "trade-selectors" });
  const statsEl = el("div", { class: "trade-stats" });
  const ratesEl = el("div", { class: "trade-rates" });
  const histEl = el("div", { class: "trade-hist" });
  const warnEl = el("div", { class: "trade-warn" });
  const colsEl = el("div", { class: "trade-cols" });
  root.append(selectorEl, statsEl, ratesEl, histEl, warnEl, colsEl);

  // ── Derived helpers ──────────────────────────────────────────────────────
  const rsFor = (a: AssetInfo) => ts.reserves.find((r) => r.asset.id === a.id);
  const posFor = (a: AssetInfo) => ts.positions.byAsset.get(a.id);
  const isFrozen = () => ts.pool.status !== 1;

  // ── Data load (mirrors old-main loadAll) ─────────────────────────────────
  async function loadAll(): Promise<void> {
    const addr = getState().userAddress;
    ts.loading = true;
    renderAll();
    try {
      // Public reads use the null account when disconnected so stats/rates show.
      const readAddr = addr ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
      ts.reserves = await fetchAllReserves(ts.pool, readAddr);
      if (addr) {
        ts.positions = await fetchUserPositions(ts.pool, addr, ts.reserves);
        ts.balance = await fetchAssetBalance(addr, ts.asset.id).catch(() => 0);
        ts.pendingBlnd = await fetchPoolPendingBlnd(ts.pool, addr, ts.positions).catch(() => 0);
        // Default to adjust mode if a position exists for the selected asset.
        ts.mode = ts.positions.byAsset.has(ts.asset.id) ? "adjust" : "open";
        if (ts.positions.byAsset.has(ts.asset.id)) {
          void refreshEvents(addr);
        }
      } else {
        ts.positions = { byAsset: new Map() };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Trade: load failed", e);
      toast(`Failed to load pool data: ${msg.slice(0, 120)}`, "error");
    } finally {
      ts.loading = false;
      renderAll();
      void loadHistory();
    }
  }

  async function refreshEvents(addr: string): Promise<void> {
    try {
      const events = await fetchPositionEvents(ts.pool, addr, ts.asset.id);
      if (events.length) {
        ts.events = events;
        renderColumns();
      }
    } catch {
      /* timeline degrades to empty */
    }
  }

  // ── Refresh only the balance for the selected asset (mirrors refreshTabData) ─
  async function refreshBalance(): Promise<void> {
    const addr = getState().userAddress;
    if (!addr) return;
    try {
      ts.balance = await fetchAssetBalance(addr, ts.asset.id);
    } catch {
      /* ignore */
    }
  }

  // ── APY-history sparkline (server time-series) ───────────────────────────
  async function loadHistory(): Promise<void> {
    const rs = rsFor(ts.asset);
    if (!rs) return;
    try {
      const series = await fetchSnapshotSeries(ts.pool.id, ts.asset.symbol, "net_supply_apr");
      const pts = series.map((p) => p.val).filter((v) => Number.isFinite(v));
      renderHistory(pts);
    } catch {
      renderHistory([]);
    }
  }

  // ── Renderers ─────────────────────────────────────────────────────────────

  function renderAll(): void {
    renderSelectors();
    renderStats();
    renderRates();
    renderHistory(null);
    renderWarnings();
    renderColumns();
  }

  function renderSelectors(): void {
    // Pool dropdown (native <select>-style button + menu). Frozen pools show an
    // amber "Frozen" tag and net supply/borrow APY.
    const poolLabel = el("span", { class: "trade-sel__cap" }, ["Pool"]);

    const menu = el("div", { class: "trade-pool-menu is-hidden" });
    const rebuildMenu = () => {
      menu.replaceChildren(
        ...pools.map((p) => {
          const frozen = p.status !== 1;
          const active = p.id === ts.pool.id;
          const item = el(
            "button",
            { class: "trade-pool-item" + (active ? " is-active" : ""), type: "button" },
            [
              el("span", { class: "trade-pool-item__name" }, [
                p.name,
                frozen ? el("span", { class: "trade-pool-item__frozen" }, ["Frozen"]) : null,
              ]),
            ],
          );
          on(item, "click", () => {
            menu.classList.add("is-hidden");
            if (p.id !== ts.pool.id) selectPool(p);
          });
          return item;
        }),
        el("div", { class: "trade-pool-menu__foot" }, ["select a pool"]),
      );
    };
    rebuildMenu();

    const toggle = el("button", { class: "trade-pool-toggle", type: "button" }, [
      `${ts.pool.name} Pool`,
      isFrozen() ? el("span", { class: "trade-pool-toggle__frozen" }, ["Frozen"]) : null,
      el("span", { class: "trade-pool-toggle__caret", "aria-hidden": "true" }, ["▾"]),
    ]);
    on(toggle, "click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("is-hidden");
    });
    // Close on outside click.
    document.addEventListener("click", () => menu.classList.add("is-hidden"));

    const poolGroup = el("div", { class: "trade-sel__group trade-sel__pool" }, [poolLabel, toggle, menu]);

    // Asset pill tabs.
    const assetCap = el("span", { class: "trade-sel__cap" }, ["Asset"]);
    const tabs = el(
      "div",
      { class: "trade-asset-tabs" },
      ts.assets.map((a) => {
        const tab = el(
          "button",
          {
            class: "tl-asset-tab" + (a.id === ts.asset.id ? " is-active" : ""),
            type: "button",
            role: "tab",
            "aria-selected": a.id === ts.asset.id ? "true" : "false",
          },
          [el("span", { class: "tl-asset-tab__sym" }, [a.symbol])],
        );
        on(tab, "click", () => selectAsset(a));
        return tab;
      }),
    );
    const assetGroup = el("div", { class: "trade-sel__group" }, [assetCap, tabs]);

    selectorEl.replaceChildren(poolGroup, assetGroup);
  }

  function renderStats(): void {
    const rs = rsFor(ts.asset);
    const skel = ts.loading || !rs;

    const util = rs && rs.totalSupply > 0 ? rs.totalBorrow / rs.totalSupply : 0;
    const utilPct = util * 100;
    const cFactor = rs ? rs.cFactor : ts.asset.cFactor;

    const totalSuppliedUsd = rs ? rs.totalSupply * rs.priceUsd : 0;
    const availableUsd = rs ? rs.available * rs.priceUsd : 0;

    statsEl.replaceChildren(
      StatCard({
        label: lbl("Total Supplied", "Total of this asset supplied to the pool (USD)."),
        value: skel ? Skeleton({ width: 64, height: 17 }) : money(totalSuppliedUsd),
      }),
      StatCard({
        label: lbl("Available", "Liquidity available to borrow or withdraw right now (USD)."),
        value: skel ? Skeleton({ width: 56, height: 17 }) : money(availableUsd),
      }),
      StatCard({
        label: lbl(
          "Utilization",
          "Borrowed ÷ supplied across the pool. High utilization means tight liquidity — exiting can be harder and forced-liquidation risk rises.",
        ),
        value: skel ? Skeleton({ width: 40, height: 17 }) : `${fmt(utilPct, 1)}%`,
        tone: utilPct >= 80 ? "warning" : "default",
        bar: skel ? undefined : utilPct,
      }),
      StatCard({
        label: lbl(
          "Collateral Factor",
          "How much you can borrow per unit of collateral. A higher c_factor allows higher leverage. c_factor = 0 means this asset can't be used as collateral.",
        ),
        value: skel ? Skeleton({ width: 44, height: 17 }) : cFactor > 0 ? cFactor.toFixed(2) : "0.00",
        tone: cFactor > 0 ? "default" : "danger",
      }),
    );
  }

  function renderRates(): void {
    const rs = rsFor(ts.asset);
    const skel = ts.loading || !rs;

    // APY vs APR (SPEC): interest compounds, BLND emissions do not.
    //   netSupplyApy = aprToApy(interestSupplyApr) + blndSupplyApr
    //   netBorrowApy = aprToApy(interestBorrowApr) − blndBorrowApr
    const intSupply = rs ? rs.interestSupplyApr : 0;
    const blndSupply = rs ? rs.blndSupplyApr : 0;
    const intBorrow = rs ? rs.interestBorrowApr : 0;
    const blndBorrow = rs ? rs.blndBorrowApr : 0;
    const netSupplyApy = aprToApy(intSupply) + blndSupply;
    const netBorrowApy = aprToApy(intBorrow) - blndBorrow;

    const rateCard = (
      title: string,
      tip: string,
      rows: Array<[string, string, string]>,
      net: [string, string, string],
    ) =>
      el("div", { class: "trade-rate" }, [
        el("div", { class: "trade-rate__title" }, [title, Tooltip({ text: tip })]),
        ...rows.map(([k, v, cls]) =>
          el("div", { class: "trade-rate__row" }, [
            el("span", { class: "trade-rate__k" }, [k]),
            skel
              ? Skeleton({ width: 52, height: 14 })
              : el("span", { class: `trade-mono trade-rate__v ${cls}` }, [v]),
          ]),
        ),
        el("div", { class: "trade-rate__net" }, [
          el("span", { class: "trade-rate__k trade-rate__k--net" }, [net[0]]),
          skel
            ? Skeleton({ width: 64, height: 15 })
            : el("span", { class: `trade-mono trade-rate__v trade-rate__v--net ${net[2]}` }, [net[1]]),
        ]),
      ]);

    ratesEl.replaceChildren(
      rateCard(
        "Supply side",
        "Interest compounds into APY; BLND emissions are an APR that doesn't compound. Net supply APY = aprToApy(interest) + emissions.",
        [
          ["Base interest (APR)", "+" + fmt(intSupply) + "%", "trade-rate__v--plain"],
          ["BLND emissions", "+" + fmt(blndSupply) + "%", "trade-rate__v--blnd"],
        ],
        ["Net supply APY", "+" + fmt(netSupplyApy) + "%", "trade-rate__v--up"],
      ),
      rateCard(
        "Borrow side",
        "Borrowers also receive BLND emissions, which reduce the effective cost. Net borrow APY = aprToApy(interest) − emissions.",
        [
          ["Base interest (APR)", "−" + fmt(intBorrow) + "%", "trade-rate__v--plain"],
          ["BLND emissions", "+" + fmt(blndBorrow) + "%", "trade-rate__v--blnd"],
        ],
        ["Net borrow APY", "−" + fmt(netBorrowApy) + "%", "trade-rate__v--down"],
      ),
    );
  }

  /** @param pts pass null to keep last sparkline; [] for "no history yet". */
  function renderHistory(pts: number[] | null): void {
    const rs = rsFor(ts.asset);
    const netSupplyApy = rs ? aprToApy(rs.interestSupplyApr) + rs.blndSupplyApr : 0;

    const cap = el("span", { class: "trade-hist__cap" }, [
      "Net supply APY · 7d",
      Tooltip({ text: "Net supply APY history from the Turbolong snapshot service." }),
    ]);

    let spark: Node;
    if (pts === null) {
      // Keep whatever's there; only refresh the value side. Re-fetch will replace.
      spark = el("span", { class: "trade-hist__nodata" }, ["—"]);
    } else if (pts.length >= 2) {
      spark = Sparkline({ data: pts, width: 120, height: 22, tone: "primary" });
    } else {
      spark = el("span", { class: "trade-hist__nodata" }, ["building history…"]);
    }

    const valEl = el("span", { class: "trade-mono trade-hist__val" }, [fmt(netSupplyApy) + "%"]);

    histEl.replaceChildren(el("div", { class: "trade-hist__strip" }, [cap, spark, valEl]));
  }

  function renderWarnings(): void {
    const rs = rsFor(ts.asset);
    const cFactor = rs ? rs.cFactor : ts.asset.cFactor;
    const kids: HTMLElement[] = [];
    if (isFrozen()) {
      kids.push(
        el("div", { class: "trade-banner trade-banner--warn" }, [
          "⚠ This pool is frozen. New positions can't be opened, and exiting may be hard — avoid adding exposure here.",
        ]),
      );
    } else if (cFactor === 0) {
      kids.push(
        el("div", { class: "trade-banner trade-banner--warn" }, [
          `⚠ ${ts.asset.symbol} can't be used as collateral in this pool (c_factor = 0), so it can't be looped. Pick another asset to open a leveraged position.`,
        ]),
      );
    }
    warnEl.replaceChildren(...kids);
  }

  function renderColumns(): void {
    colsEl.replaceChildren(actionCard(), positionCard());
  }

  // ── Selection handlers ────────────────────────────────────────────────────
  function selectPool(p: PoolDef): void {
    ts.pool = p;
    ts.assets = getPoolAssets(p);
    ts.asset = ts.assets[0];
    ts.reserves = [];
    ts.positions = { byAsset: new Map() };
    ts.events = [];
    ts.balance = 0;
    ts.pendingBlnd = 0;
    ts.mode = "open";
    renderAll();
    void loadAll();
  }

  function selectAsset(a: AssetInfo): void {
    ts.asset = a;
    ts.events = [];
    ts.mode = ts.positions.byAsset.has(a.id) ? "adjust" : "open";
    renderSelectors();
    renderStats();
    renderRates();
    renderHistory([]);
    renderColumns();
    void refreshBalance().then(renderColumns);
    void loadHistory();
    const addr = getState().userAddress;
    if (addr && ts.positions.byAsset.has(a.id)) void refreshEvents(addr);
  }

  // ── Preview math (ports old-main updatePreview) ───────────────────────────
  interface Preview {
    lev: number;
    hf: number;
    supply: number;
    borrow: number;
    equity: number;
    curNetApy: number;
    projNetApy: number;
    liqDays: number | null; // null → "—", Infinity → "Never"
    liquidityOk: boolean;
  }

  function computePreview(lev: number, depositOverride?: number): Preview {
    const rs = rsFor(ts.asset);
    const c = rs ? rs.cFactor : ts.asset.cFactor;
    const l = rs?.lFactor ?? 1;
    const hf = hfForLeverage(lev, c, l);
    const pos = posFor(ts.asset);

    const removeAmt = ts.mode === "remove-funds" ? depositOverride ?? 0 : 0;
    // Base equity per mode — identical selection to old-main updatePreview.
    const equity =
      ts.mode === "adjust" && pos
        ? pos.equity
        : ts.mode === "add-funds"
          ? depositOverride ?? 0
          : ts.mode === "remove-funds" && pos
            ? Math.max(0, pos.equity - removeAmt)
            : depositOverride ?? 0;

    const supply = equity * lev;
    const borrow = equity * (lev - 1);

    // When adjusting / removing on an existing position, its supply/borrow are
    // already in the pool totals — pass the net delta so projectRates doesn't
    // double-count.
    const oldSupply = (ts.mode === "adjust" || ts.mode === "remove-funds") && pos ? pos.collateral : 0;
    const oldBorrow = (ts.mode === "adjust" || ts.mode === "remove-funds") && pos ? pos.debt : 0;

    let curNetApy = 0;
    let projNetApy = Number.NaN;
    let liqDays: number | null = null;
    if (rs) {
      const cur = projectRates(rs, 0, 0);
      curNetApy = aprToApy(cur.netSupplyApr * lev - cur.netBorrowCost * (lev - 1));
      const proj = projectRates(rs, supply - oldSupply, borrow - oldBorrow);
      projNetApy = aprToApy(proj.netSupplyApr * lev - proj.netBorrowCost * (lev - 1));

      // Days until liquidation at this leverage (interest-only, no BLND).
      const spreadPct = proj.interestBorrowApr - proj.interestSupplyApr;
      if (spreadPct <= 0) {
        liqDays = Number.POSITIVE_INFINITY;
      } else if (Number.isFinite(hf) && hf > 1) {
        liqDays = (Math.log(hf) / (spreadPct / 100)) * 365;
      } else {
        liqDays = null;
      }
    }

    // Liquidity check (open / add-funds modes) — same as old-main.
    let liquidityOk = true;
    if (ts.mode === "open" || ts.mode === "add-funds") {
      const initial = equity;
      const totalBorrow = initial * (lev - 1);
      const cf = rs ? rs.cFactor : ts.asset.cFactor;
      const firstBorrow = Math.min(initial * cf, totalBorrow);
      const poolAvailAfterDeposit = (rs?.available ?? 0) + initial * (rs ? rs.asset.maxUtil : 0.95);
      liquidityOk = !rs || firstBorrow <= poolAvailAfterDeposit;
    }

    return { lev, hf, supply, borrow, equity, curNetApy, projNetApy, liqDays, liquidityOk };
  }

  // ── ACTION CARD ───────────────────────────────────────────────────────────
  function actionCard(): HTMLElement {
    const addr = getState().userAddress;
    const rs = rsFor(ts.asset);
    const pos = posFor(ts.asset);
    const hasPosition = !!pos;
    const c = rs ? rs.cFactor : ts.asset.cFactor;
    const l = rs?.lFactor ?? 1;
    const canCollateralize = c > 0 && !isFrozen();
    const maxLev = Math.max(1, Math.floor(maxLeverageFor(c, l, minHF()) * 10) / 10);
    const leverageable = maxLev > 1.0;

    if (!addr) {
      return Card({
        title: "Open Position",
        class: "trade-action",
        children: el("div", { class: "trade-connect" }, [
          el("p", { class: "trade-connect__msg" }, ["Connect your wallet to open a leveraged position."]),
          el("p", { class: "trade-connect__sub" }, [
            "Pool stats and rates above are live and public — connect to deposit, adjust, or close.",
          ]),
        ]),
      });
    }

    // Sub-tabs when adjusting an existing position.
    const subTabs = hasPosition
      ? el(
          "div",
          { class: "trade-subtabs" },
          ([
            ["adjust", "Leverage"],
            ["add-funds", "Add Funds"],
            ["remove-funds", "Remove Funds"],
          ] as Array<[ActionMode, string]>).map(([k, label]) => {
            const b = el(
              "button",
              { class: "trade-subtab" + (ts.mode === k ? " is-active" : ""), type: "button" },
              [label],
            );
            on(b, "click", () => {
              ts.mode = k;
              renderColumns();
            });
            return b;
          }),
        )
      : null;

    const title = hasPosition ? "Adjust Position" : "Open Position";

    // Body switches on mode.
    let body: HTMLElement;
    if (hasPosition && ts.mode === "add-funds") body = addFundsBody(pos, maxLev);
    else if (hasPosition && ts.mode === "remove-funds") body = removeFundsBody(pos);
    else body = openOrLeverageBody(hasPosition, pos, c, maxLev, leverageable, canCollateralize, addr);

    return Card({ title, class: "trade-action", children: [subTabs, body].filter(Boolean) as HTMLElement[] });
  }

  // OPEN (no position) or ADJUST-LEVERAGE (has position)
  function openOrLeverageBody(
    hasPosition: boolean,
    pos: AssetPosition | undefined,
    c: number,
    maxLev: number,
    leverageable: boolean,
    canCollateralize: boolean,
    addr: string,
  ): HTMLElement {
    const sym = ts.asset.symbol;
    const wrap = el("div", { class: "trade-body" });

    // Live state for this body.
    let deposit = hasPosition && pos ? pos.equity : 0;
    const initialLev = hasPosition && pos ? Math.round(pos.leverage * 10) / 10 : Math.min(3, maxLev);
    let lev = Math.min(Math.max(1, initialLev), leverageable ? maxLev : 1);

    // Deposit input (open only).
    let depInput: HTMLElement | null = null;
    let depField: HTMLInputElement | null = null;
    if (!hasPosition) {
      depInput = Input({
        value: "",
        placeholder: "0.00",
        inputMode: "decimal",
        suffix: sym,
        onMax: () => {
          if (depField) {
            depField.value = String(Math.floor(ts.balance * 1e7) / 1e7);
            deposit = Number.parseFloat(depField.value) || 0;
            refresh();
          }
        },
        onChange: (v) => {
          deposit = Number.parseFloat(v.replace(/[^\d.]/g, "")) || 0;
          refresh();
        },
      });
      depField = depInput.querySelector("input");
      wrap.append(
        el("div", { class: "trade-field" }, [
          el("label", { class: "trade-field__label" }, ["Deposit"]),
          depInput,
          el("span", { class: "trade-hint" }, [`Balance: `, el("span", { class: "trade-mono" }, [`${fmt(ts.balance, 4)} ${sym}`])]),
        ]),
      );
    }

    // Leverage slider.
    const levLabel = el("label", { class: "trade-field__label" }, [
      lbl(
        hasPosition ? "Target leverage" : "Leverage",
        "How many times your deposit is looped as exposure. The ceiling is set by the collateral factor; higher leverage means a lower Health Factor.",
      ),
    ]);
    const levBlock = el("div", { class: "trade-field" }, [levLabel]);
    if (leverageable) {
      const slider = LeverageSlider({
        value: lev,
        min: 1,
        max: maxLev,
        step: 0.1,
        expert: getState().expert,
        onChange: (v) => {
          lev = v;
          refresh();
        },
      });
      const maxNote = el("div", { class: "trade-mono trade-maxnote" }, [
        `Max ${maxLev.toFixed(1)}× at c_factor ${c.toFixed(2)}${getState().expert ? " · expert" : ""}`,
      ]);
      levBlock.append(slider, maxNote);
      if (getState().expert) {
        levBlock.append(
          el("div", { class: "trade-expert-note" }, [
            "⚠ Expert mode: min Health Factor lowered to ~1.00001 (≈0.001% from liquidation). For active monitors only.",
          ]),
        );
      }
    } else {
      levBlock.append(
        el("div", { class: "trade-hint" }, [`Leverage unavailable — ${sym} isn't collateral-eligible here.`]),
      );
    }
    wrap.append(levBlock);

    // Preview well.
    const previewWell = el("div", { class: "trade-well" });
    wrap.append(previewWell);

    // Return calculator.
    const calcWell = el("div", { class: "trade-well trade-calc" });
    wrap.append(calcWell);

    // Health + risk.
    const hfWell = el("div", { class: "trade-hf-well" });
    const riskWell = el("div", { class: "trade-risk-well" });
    wrap.append(hfWell, riskWell);

    // Negative-APY warning.
    const negWarn = el("div", { class: "trade-banner trade-banner--warn is-hidden" }, [
      "⚠ Projected net APY is negative at this leverage — you'd pay more in borrow cost than you earn.",
    ]);
    wrap.append(negWarn);

    // Primary action button.
    const actionBtn = Button({ variant: "primary", size: "lg", fullWidth: true, children: "" });
    wrap.append(actionBtn);

    wrap.append(
      el("p", { class: "trade-caveat" }, [
        "The loop runs atomically. If your collateral value drops enough, your position is liquidated and you lose collateral.",
      ]),
    );

    function refresh(): void {
      const p = computePreview(lev, deposit);
      const z = zoneFromHF(p.hf);

      // Preview well.
      const liqText =
        p.liqDays === null
          ? "—"
          : !Number.isFinite(p.liqDays)
            ? "Never (supply ≥ borrow)"
            : p.liqDays > 3650
              ? "Over 10y"
              : `~${Math.round(p.liqDays)} days`;
      previewWell.replaceChildren(
        previewRow("Total collateral", `${fmt(p.supply)} ${sym}`),
        previewRow("Total borrowed", `${fmt(p.borrow)} ${sym}`),
        el("div", { class: "trade-well__div" }, [
          previewRow(
            lbl("Current pool APY", "Net leveraged APY at the pool's current rates, before your deposit moves them."),
            `${p.curNetApy >= 0 ? "+" : ""}${fmt(p.curNetApy)}%`,
            "trade-tone-2",
          ),
          previewRow(
            lbl(
              "Projected net APY",
              "Projected APY after your deposit — accounts for how your supply/borrow shifts pool utilization and rates. Shown as APY; the executable figure is an APR slightly below this.",
            ),
            Number.isFinite(p.projNetApy) ? `${p.projNetApy >= 0 ? "+" : ""}${fmt(p.projNetApy)}%` : "—",
            Number.isFinite(p.projNetApy) ? (p.projNetApy >= 0 ? "trade-tone-up" : "trade-tone-down") : "",
            true,
          ),
          previewRow(
            lbl("Days to liquidation", "At current rates, the time until borrow interest erodes your buffer to liquidation."),
            liqText,
          ),
        ]),
      );

      // Return calculator.
      const annualReturn = deposit * ((Number.isFinite(p.projNetApy) ? p.projNetApy : 0) / 100);
      const periodProfit = annualReturn * (ts.holdDays / 365);
      const roi = deposit > 0 ? (periodProfit / deposit) * 100 : 0;
      const calcHead = el("div", { class: "trade-calc__head" }, [
        el("span", { class: "trade-calc__cap" }, [
          "Return calculator",
          Tooltip({
            text:
              "Simulates the projected return on your equity if rates held constant over the holding period. Not a guarantee — rates drift and you can be liquidated.",
          }),
        ]),
        el(
          "div",
          { class: "trade-calc__chips" },
          [30, 90, 180, 365].map((d) => {
            const chip = el(
              "button",
              { class: "trade-calc__chip" + (ts.holdDays === d ? " is-active" : ""), type: "button" },
              [d === 365 ? "1y" : `${d}d`],
            );
            on(chip, "click", () => {
              ts.holdDays = d;
              refresh();
            });
            return chip;
          }),
        ),
      ]);
      calcWell.replaceChildren(
        calcHead,
        previewRow(
          `Projected profit · ${ts.holdDays === 365 ? "1 year" : ts.holdDays + " days"}`,
          `${periodProfit >= 0 ? "+" : "−"}${money(Math.abs(periodProfit))} ${sym}`,
          periodProfit >= 0 ? "trade-tone-up" : "trade-tone-down",
        ),
        previewRow("Equity after", `${money(deposit + periodProfit)} ${sym}`),
        previewRow(
          "Return on equity",
          `${roi >= 0 ? "+" : ""}${fmt(roi, 1)}%`,
          roi >= 0 ? "trade-tone-up" : "trade-tone-down",
        ),
      );

      // Health + risk.
      hfWell.replaceChildren(
        HealthFactor({
          value: Number.isFinite(p.hf) ? p.hf : 3,
          label: "Account Health",
          labelTitle:
            "Pool-wide: total collateral value ÷ total debt across every asset in this pool. Liquidation is account-wide — it triggers when this drops below 1.0, not per asset.",
        }),
      );
      riskWell.replaceChildren(RiskBand({ zone: z }));

      // Warnings.
      const showNeg = canCollateralize && Number.isFinite(p.projNetApy) && p.projNetApy < 0;
      negWarn.classList.toggle("is-hidden", !showNeg);

      // Button label + disabled state — mirrors old-main updatePreview gating.
      const safe = p.hf >= minHF() && !isFrozen() && p.liquidityOk;
      if (hasPosition) {
        const curLev = pos ? Math.round(pos.leverage * 10) / 10 : 1;
        const changed = Math.abs(lev - curLev) >= 0.1;
        actionBtn.textContent =
          lev > curLev ? `Increase to ${lev.toFixed(1)}×` : lev < curLev ? `Decrease to ${lev.toFixed(1)}×` : "Adjust Leverage";
        actionBtn.disabled = !safe || !changed;
      } else {
        actionBtn.textContent = !canCollateralize ? "Not collateral-eligible" : "Confirm & Open";
        actionBtn.disabled = !canCollateralize || !safe || deposit <= 0;
      }
    }

    on(actionBtn, "click", () => {
      if (hasPosition && pos) void adjustLeverage(lev);
      else void openPosition(deposit, lev);
    });

    refresh();
    return wrap;
  }

  // ADD FUNDS body
  function addFundsBody(pos: AssetPosition, maxLev: number): HTMLElement {
    const sym = ts.asset.symbol;
    const curLev = Math.min(Math.max(1, Math.round(pos.leverage * 10) / 10), maxLev);
    let amount = 0;

    const input = Input({
      value: "",
      placeholder: "0.00",
      inputMode: "decimal",
      suffix: sym,
      onMax: () => {
        field.value = String(Math.floor(ts.balance * 1e7) / 1e7);
        amount = Number.parseFloat(field.value) || 0;
        refresh();
      },
      onChange: (v) => {
        amount = Number.parseFloat(v.replace(/[^\d.]/g, "")) || 0;
        refresh();
      },
    });
    const field = input.querySelector("input") as HTMLInputElement;

    const btn = Button({ variant: "primary", size: "lg", fullWidth: true, children: "Add Funds" });

    function refresh(): void {
      const p = computePreview(curLev, amount);
      const safe = p.hf >= minHF() && !isFrozen() && p.liquidityOk;
      btn.disabled = !safe || amount <= 0;
      btn.textContent = amount > 0 ? `Add ${fmt(amount)} ${sym} at ${curLev.toFixed(1)}×` : "Add Funds";
    }
    on(btn, "click", () => void addFundsToPosition(amount, curLev));
    refresh();

    return el("div", { class: "trade-body" }, [
      el("div", { class: "trade-field" }, [
        el("label", { class: "trade-field__label" }, ["Add capital"]),
        input,
        el("span", { class: "trade-hint" }, [`Wallet: `, el("span", { class: "trade-mono" }, [`${fmt(ts.balance, 4)} ${sym}`])]),
      ]),
      el("div", { class: "trade-field" }, [
        el("label", { class: "trade-field__label" }, [
          lbl("At current leverage", "New capital is looped at your current leverage, keeping your Health Factor roughly the same."),
        ]),
        el("div", { class: "trade-mono trade-curlev" }, [`${curLev.toFixed(1)}×`]),
      ]),
      btn,
    ]);
  }

  // REMOVE FUNDS body
  function removeFundsBody(pos: AssetPosition): HTMLElement {
    const sym = ts.asset.symbol;
    let amount = 0;

    const input = Input({
      value: "",
      placeholder: "0.00",
      inputMode: "decimal",
      suffix: sym,
      onMax: () => {
        field.value = String(Math.floor(pos.equity * 0.9 * 1e7) / 1e7);
        amount = Number.parseFloat(field.value) || 0;
        refresh();
      },
      onChange: (v) => {
        amount = Number.parseFloat(v.replace(/[^\d.]/g, "")) || 0;
        refresh();
      },
    });
    const field = input.querySelector("input") as HTMLInputElement;

    const btn = Button({ variant: "primary", size: "lg", fullWidth: true, children: "Remove Funds" });

    function refresh(): void {
      const tooMuch = amount >= pos.equity;
      btn.disabled = amount <= 0 || tooMuch || isFrozen();
      btn.textContent = tooMuch
        ? "Use Close to exit fully"
        : amount > 0
          ? `Remove ${fmt(amount)} ${sym}`
          : "Remove Funds";
    }
    on(btn, "click", () => void removeFundsFromPosition(amount));
    refresh();

    return el("div", { class: "trade-body" }, [
      el("div", { class: "trade-inpos" }, [
        el("span", {}, ["In position"]),
        el("span", { class: "trade-mono trade-inpos__val" }, [`${money(pos.equity)} ${sym}`]),
      ]),
      el("div", { class: "trade-field" }, [
        el("label", { class: "trade-field__label" }, ["Withdraw principal"]),
        input,
      ]),
      el("p", { class: "trade-note" }, [
        "Withdraws part of your principal and unwinds proportionally — your leverage and Health Factor stay the same. Use ",
        el("b", {}, ["Close"]),
        " to exit fully.",
      ]),
      btn,
    ]);
  }

  // ── POSITION CARD ─────────────────────────────────────────────────────────
  function positionCard(): HTMLElement {
    const addr = getState().userAddress;
    const pos = posFor(ts.asset);

    if (!addr) {
      return Card({
        title: "Position",
        class: "trade-position",
        children: el("div", { class: "trade-connect" }, [
          el("p", { class: "trade-connect__msg" }, ["Connect your wallet to see your position."]),
        ]),
      });
    }

    if (!pos) {
      return Card({
        title: "Position",
        class: "trade-position",
        children: el("div", { class: "trade-empty" }, [
          el("div", { class: "trade-empty__glyph", "aria-hidden": "true" }, ["◎"]),
          "No open position. Set your deposit and leverage, then open one.",
        ]),
      });
    }

    return Card({
      title: "Your Position",
      class: "trade-position",
      action: Badge({ tone: "primary", dot: true, children: "Open" }),
      children: positionDetail(pos),
    });
  }

  function positionDetail(pos: AssetPosition): HTMLElement {
    const rs = rsFor(ts.asset);
    const sym = ts.asset.symbol;

    // Account-wide aggregate (cross-margined HF + net APY + effective leverage).
    const agg = aggregatePoolAccount([...ts.positions.byAsset.values()], ts.reserves);
    const accountHF = agg.poolHF;
    const netApy = agg.netApy;
    const effLev = agg.effLeverage;
    const cFactor = rs ? rs.cFactor : ts.asset.cFactor;

    // 3 hero metrics.
    const heroes = el("div", { class: "trade-heroes" }, [
      MetricHero({ label: "Your Equity", value: money(agg.equityUsd) }),
      MetricHero({
        label: "Leverage",
        value: `${effLev.toFixed(1)}×`,
        tone: effLev > 7 ? "danger" : effLev > 4 ? "warning" : "default",
      }),
      MetricHero({
        label: "Net APY",
        value: `${netApy >= 0 ? "+" : ""}${fmt(netApy, 1)}%`,
        tone: netApy >= 0 ? "success" : "danger",
        sub: "projected",
      }),
    ]);

    // Account Health.
    const hfWell = el("div", { class: "trade-hf-well" }, [
      HealthFactor({
        value: Number.isFinite(accountHF) ? accountHF : 3,
        label: "Account Health",
        labelTitle:
          "Pool-wide: total collateral value ÷ total debt across every asset in this pool. Liquidation is account-wide — it triggers when this drops below 1.0, not per asset.",
      }),
    ]);

    // Detail rows.
    const liqMovePct = pos.leverage > 1 ? Math.round((1 - 1 / pos.leverage) * 100) : 0;
    const liqDays =
      agg.liqDays === null
        ? "—"
        : !Number.isFinite(agg.liqDays)
          ? "Never (supply ≥ borrow)"
          : agg.liqDays > 3650
            ? "Over 10y"
            : `~${Math.round(agg.liqDays)} days`;
    const rows: Array<[HTMLElement | string, string]> = [
      ["Pool / Asset", `${sym} · ${ts.pool.name}`],
      ["Collateral", `${fmt(pos.collateral)} ${sym}`],
      ["Borrowed", `${fmt(pos.debt)} ${sym}`],
      [lbl("Collateral factor", "How much you can borrow per unit of collateral in this pool."), cFactor.toFixed(2)],
      [
        lbl("Liquidation price", "The adverse collateral-price move that would push your Health Factor to 1.0."),
        `−${liqMovePct}% move`,
      ],
      [
        lbl(
          "Days to liquidation",
          "At current rates, the time until borrow interest erodes your buffer to liquidation. Claim & convert BLND to extend it.",
        ),
        liqDays,
      ],
    ];
    const detailRows = el(
      "div",
      { class: "trade-detail" },
      rows.map(([k, v]) =>
        el("div", { class: "trade-detail__row" }, [
          typeof k === "string" ? el("span", { class: "trade-detail__k" }, [k]) : k,
          el("span", { class: "trade-mono trade-detail__v" }, [v]),
        ]),
      ),
    );

    // Activity timeline (on-chain events + Stellar Expert links).
    const timeline = el("div", { class: "trade-activity" }, [
      el("div", { class: "trade-activity__cap" }, ["Activity"]),
    ]);
    if (ts.events.length) {
      for (const ev of ts.events.slice(0, 5)) {
        const short = ev.hash.slice(0, 6);
        timeline.append(
          el("div", { class: "trade-activity__row" }, [
            el("span", { class: `trade-activity__ic trade-activity__ic--${ev.kind}`, "aria-hidden": "true" }, [
              ev.kind === "open" ? "+" : ev.kind === "harvest" ? "★" : ev.kind === "close" ? "⊗" : "↑",
            ]),
            el("span", { class: "trade-activity__label" }, [EVENT_LABELS[ev.kind] ?? ev.kind]),
            el("span", { class: "trade-mono trade-activity__time" }, [relTime(ev.timestamp)]),
            el(
              "a",
              { class: "trade-mono trade-activity__link", href: expertUrl("tx", ev.hash), target: "_blank", rel: "noopener", title: "View transaction on Stellar Expert" },
              [`${short}… ↗`],
            ),
          ]),
        );
      }
    } else {
      timeline.append(el("div", { class: "trade-activity__empty" }, ["No on-chain activity yet for this position."]));
    }
    timeline.append(
      el("div", { class: "trade-activity__foot" }, [
        "View position on ",
        el("a", { href: expertUrl("contract", ts.pool.id), target: "_blank", rel: "noopener" }, ["Stellar Expert ↗"]),
      ]),
    );

    // BLND rewards row — Claim & Convert (compound via Add Funds; NO Resupply).
    const compoundBtn = Button({ variant: "secondary", size: "sm", children: "Claim & Convert" });
    compoundBtn.disabled = ts.pendingBlnd <= 0;
    on(compoundBtn, "click", () => void claimAndConvert());
    const blndRow = el("div", { class: "trade-blnd" }, [
      el("div", { class: "trade-blnd__left" }, [
        el("span", { class: "trade-blnd__dot", "aria-hidden": "true" }),
        el("span", { class: "trade-blnd__cap" }, [
          "BLND rewards",
          Tooltip({
            text:
              "Emissions earned by this position. Claim & Convert swaps your BLND to your collateral asset and credits your wallet — then use Add Funds to compound it back into the loop and extend your days-to-liquidation.",
          }),
        ]),
        el("span", { class: "trade-mono trade-blnd__amt" }, [`${fmt(ts.pendingBlnd, 4)} BLND`]),
      ]),
      compoundBtn,
    ]);

    // Action: Close only. (Add Funds / Remove Funds live in the Adjust card's sub-tabs.)
    const closeBtn = Button({ variant: "danger", children: "Close" });
    on(closeBtn, "click", () => askClose(pos));
    const actions = el("div", { class: "trade-actions" }, [closeBtn]);

    return el("div", {}, [heroes, hfWell, detailRows, timeline, blndRow, actions]);
  }

  // ── Close confirmation (inline, replaces position body) ───────────────────
  function askClose(pos: AssetPosition): void {
    const sym = ts.asset.symbol;
    const card = colsEl.querySelector(".trade-position .tl-card__body");
    if (!card) return;
    const cancel = Button({ variant: "ghost", children: "Cancel" });
    on(cancel, "click", () => renderColumns());
    const confirm = Button({ variant: "danger", children: "Confirm Close" });
    on(confirm, "click", () => void closePosition(pos));
    card.replaceChildren(
      el("div", { class: "trade-confirm" }, [
        el("div", { class: "trade-confirm__title" }, ["Close this position?"]),
        el("p", { class: "trade-confirm__body" }, [
          `This unwinds the full loop in one atomic transaction and returns your equity (~${money(pos.equity)} ${sym}) to your wallet. Any unclaimed BLND is forfeited unless you claim first.`,
        ]),
        el("div", { class: "trade-confirm__actions" }, [cancel, confirm]),
      ]),
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  MONEY PATHS — ported faithfully from old-main.ts. Same blend.ts builders,
  //  same arguments, same order. Do not reorder contract calls.
  // ════════════════════════════════════════════════════════════════════════

  // openPosition (~old-main 2086): trustline check → confirm gate (HF + liquidity
  // validated before) → buildApproveXdr → buildOpenPositionXdr.
  async function openPosition(initial: number, leverage: number): Promise<void> {
    const addr = getState().userAddress;
    if (!addr) return;
    if (isFrozen()) {
      toast("Pool is frozen — cannot open a position", "error");
      return;
    }
    if (Number.isNaN(initial) || initial <= 0) {
      toast("Enter a valid amount", "error");
      return;
    }
    const rs = rsFor(ts.asset);
    const liveAsset = rs?.asset ?? ts.asset;

    if (hfForLeverage(leverage, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) {
      toast("Health factor too low at this leverage", "error");
      return;
    }
    // Liquidity validation (same as old-main openPosition).
    const totalBorrow = initial * (leverage - 1);
    const firstBorrow = Math.min(initial * liveAsset.cFactor, totalBorrow);
    const poolAvailAfterDeposit = (rs?.available ?? 0) + initial * (rs ? rs.asset.maxUtil : 0.95);
    if (rs && firstBorrow > poolAvailAfterDeposit) {
      toast(
        `First borrow (${fmt(firstBorrow, 0)}) exceeds pool available after deposit (${fmt(poolAvailAfterDeposit, 0)} ${rs.asset.symbol})`,
        "error",
      );
      return;
    }

    // Confirm gate.
    const confirmed = await confirmPositionModal(initial, leverage, liveAsset, rs);
    if (!confirmed) return;

    const initialStroops = BigInt(Math.round(initial * 1e7));

    // Trustline check (getMissingTrustlines).
    let trustlineResult: MissingTrustlineResult = { missing: [], currentCount: 0 };
    try {
      trustlineResult = await getMissingTrustlines(ts.pool, addr, liveAsset.id);
    } catch (e) {
      toast(`Trustline check failed: ${((e as Error)?.message ?? String(e)).slice(0, 150)}`, "error");
      return;
    }
    const STELLAR_TRUSTLINE_LIMIT = 1000;
    if (trustlineResult.currentCount + trustlineResult.missing.length > STELLAR_TRUSTLINE_LIMIT) {
      toast(`Adding ${trustlineResult.missing.length} trustline(s) would exceed the account limit`, "error");
      return;
    }

    const hasMissing = trustlineResult.missing.length > 0;
    const steps = hasMissing ? ["Trustlines", "Approve", "Submit", "Confirmed"] : ["Approve", "Submit", "Confirmed"];
    const approveStep = hasMissing ? 1 : 0;
    const submitStep = hasMissing ? 2 : 1;
    const doneStep = hasMissing ? 3 : 2;
    txShow(steps);
    let cur = 0;
    try {
      if (hasMissing) {
        cur = 0;
        // buildTrustlineXdr → signAndSubmitClassic
        const trustXdr = await buildTrustlineXdr(trustlineResult.missing, addr);
        if (trustXdr) {
          await signAndSubmitClassic(trustXdr, `Add ${trustlineResult.missing.length} trustline(s)`);
        }
      }
      cur = approveStep;
      txStep(approveStep);
      // buildApproveXdr (initialStroops + 1n) → signAndSubmit
      const approveXdr = await buildApproveXdr(ts.pool, addr, liveAsset.id, initialStroops + 1n);
      await signAndSubmit(approveXdr, `Approve ${liveAsset.symbol}`);
      cur = submitStep;
      txStep(submitStep);
      // buildOpenPositionXdr (initialStroops, leverage) → signAndSubmit
      const submitXdr = await buildOpenPositionXdr(ts.pool, addr, liveAsset, initialStroops, leverage);
      await signAndSubmit(submitXdr, `Open ${liveAsset.symbol} leverage`);
      txStep(doneStep);
      txHide();
      await loadAll();
    } catch (e) {
      txStep(cur, true);
      txHide();
      toast(txErr(e), "error");
    }
  }

  // closePosition (~2195): buildCloseSubmitXdr; on #1207/#1205 with debt → two-step
  // buildRepayXdr → buildWithdrawXdr fallback.
  async function closePosition(pos: AssetPosition): Promise<void> {
    const addr = getState().userAddress;
    if (!addr) return;
    txShow(["Close Position", "Confirmed"]);
    try {
      const submitXdr = await buildCloseSubmitXdr(ts.pool, addr, pos);
      await signAndSubmit(submitXdr, `Close ${ts.asset.symbol} position`);
      txStep(1);
      txHide();
      await loadAll();
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      const utilOrHf =
        msg.includes("#1207") || msg.includes("InvalidUtilRate") || msg.includes("#1205") || msg.includes("InvalidHf");
      if (utilOrHf && pos.dTokens > 0n) {
        try {
          toast("Closing in two steps (repay debt, then withdraw collateral)…", "info");
          txShow(["Repay Debt", "Withdraw Collateral", "Confirmed"]);
          // Step 1: buildRepayXdr → signAndSubmit
          const repayXdr = await buildRepayXdr(ts.pool, addr, pos);
          await signAndSubmit(repayXdr, `Repay ${ts.asset.symbol} debt`);
          txStep(1);
          // Step 2: buildWithdrawXdr → signAndSubmit
          const withdrawXdr = await buildWithdrawXdr(ts.pool, addr, pos.asset.id);
          await signAndSubmit(withdrawXdr, `Withdraw ${ts.asset.symbol} collateral`);
          txStep(2);
          txHide();
          await loadAll();
          return;
        } catch (e2) {
          txStep(1, true);
          txHide();
          toast(txErr(e2), "error");
          await loadAll();
          return;
        }
      }
      txStep(0, true);
      txHide();
      toast(txErr(e), "error");
    }
  }

  // adjustLeverage (~2289): buildIncrease/DecreaseLeverageXdr to target lev.
  async function adjustLeverage(targetLev: number): Promise<void> {
    const addr = getState().userAddress;
    if (!addr) return;
    const pos = posFor(ts.asset);
    if (!pos) return;
    const curLev = pos.leverage;
    if (Math.abs(targetLev - curLev) < 0.05) {
      toast("Target leverage is the same as current", "error");
      return;
    }
    const rs = rsFor(ts.asset);
    const liveAsset = rs?.asset ?? ts.asset;
    if (hfForLeverage(targetLev, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) {
      toast("Health factor too low at target leverage", "error");
      return;
    }
    const direction = targetLev > curLev ? "Increase" : "Decrease";
    txShow([`${direction} Leverage`, "Confirmed"]);
    try {
      if (targetLev > curLev) {
        // buildIncreaseLeverageXdr → signAndSubmit
        const xdr = await buildIncreaseLeverageXdr(ts.pool, addr, liveAsset, pos, targetLev);
        await signAndSubmit(xdr, `Increase leverage to ${targetLev.toFixed(1)}×`);
      } else {
        // buildDecreaseLeverageXdr → signAndSubmit
        const xdr = await buildDecreaseLeverageXdr(ts.pool, addr, liveAsset, pos, targetLev);
        await signAndSubmit(xdr, `Decrease leverage to ${targetLev.toFixed(1)}×`);
      }
      txStep(1);
      txHide();
      await loadAll();
    } catch (e) {
      txStep(0, true);
      txHide();
      toast(txErr(e), "error");
    }
  }

  // addFundsToPosition (~2338): buildApproveXdr + buildOpenPositionXdr at chosen lev.
  async function addFundsToPosition(additional: number, leverage: number): Promise<void> {
    const addr = getState().userAddress;
    if (!addr) return;
    if (isFrozen()) {
      toast("Pool is frozen — cannot add funds", "error");
      return;
    }
    const pos = posFor(ts.asset);
    if (!pos) return;
    if (Number.isNaN(additional) || additional <= 0) {
      toast("Enter a valid amount", "error");
      return;
    }
    const rs = rsFor(ts.asset);
    const liveAsset = rs?.asset ?? ts.asset;
    if (hfForLeverage(leverage, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) {
      toast("Health factor too low at this leverage", "error");
      return;
    }
    const additionalStroops = BigInt(Math.round(additional * 1e7));
    txShow(["Approve", "Submit", "Confirmed"]);
    try {
      // buildApproveXdr (additionalStroops + 1n) → signAndSubmit
      const approveXdr = await buildApproveXdr(ts.pool, addr, liveAsset.id, additionalStroops + 1n);
      await signAndSubmit(approveXdr, `Approve ${liveAsset.symbol}`);
      txStep(1);
      // buildOpenPositionXdr (additionalStroops, leverage) → signAndSubmit
      const submitXdr = await buildOpenPositionXdr(ts.pool, addr, liveAsset, additionalStroops, leverage);
      await signAndSubmit(submitXdr, `Add ${fmt(additional)} ${liveAsset.symbol} at ${leverage.toFixed(1)}×`);
      txStep(2);
      txHide();
      await loadAll();
    } catch (e) {
      txStep(1, true);
      txHide();
      toast(txErr(e), "error");
    }
  }

  // removeFundsFromPosition (~2393): buildRemoveFundsXdr proportional unwind.
  async function removeFundsFromPosition(amount: number): Promise<void> {
    const addr = getState().userAddress;
    if (!addr) return;
    if (isFrozen()) {
      toast("Pool is frozen — cannot remove funds", "error");
      return;
    }
    const pos = posFor(ts.asset);
    if (!pos) return;
    if (Number.isNaN(amount) || amount <= 0) {
      toast("Enter a valid amount", "error");
      return;
    }
    if (amount >= pos.equity) {
      toast("Use Close to exit fully", "error");
      return;
    }
    txShow(["Remove Funds", "Confirmed"]);
    try {
      // buildRemoveFundsXdr → signAndSubmit
      const xdr = await buildRemoveFundsXdr(ts.pool, addr, pos, amount);
      await signAndSubmit(xdr, `Remove ${fmt(amount)} ${ts.asset.symbol}`);
      txStep(1);
      txHide();
      await loadAll();
    } catch (e) {
      txStep(0, true);
      txHide();
      toast(txErr(e), "error");
    }
  }

  // claimAndConvert (~2463): buildClaimXdr → (read BLND balance) → buildSwapBlndXdr.
  async function claimAndConvert(): Promise<void> {
    const addr = getState().userAddress;
    if (!addr) return;
    const pos = posFor(ts.asset);
    if (!pos) return;

    // Collect all token IDs for ALL positions in this pool (same as old-main).
    const tokenIds: number[] = [];
    for (const p of ts.positions.byAsset.values()) {
      if (p.bTokens > 0n) tokenIds.push(p.asset.supplyTokenId);
      if (p.dTokens > 0n) tokenIds.push(p.asset.borrowTokenId);
    }
    if (tokenIds.length === 0) {
      toast("No positions to claim from", "error");
      return;
    }

    txShow(["Claim BLND", "Swap", "Confirmed"]);
    try {
      // buildClaimXdr → signAndSubmit
      const claimXdr = await buildClaimXdr(ts.pool, addr, tokenIds);
      await signAndSubmit(claimXdr, "Claim BLND");

      // Read actual BLND balance after claim.
      const blndBalance = await fetchAssetBalance(addr, getBlndId());
      if (blndBalance <= 0) {
        toast("No BLND to convert", "error");
        txStep(2);
        txHide(1000);
        await loadAll();
        return;
      }

      txStep(1);
      toast(`Swapping ${fmt(blndBalance)} BLND → ${ts.asset.symbol}…`, "info");
      // buildSwapBlndXdr → signAndSubmitClassic
      const { xdr: swapXdr, estimate } = await buildSwapBlndXdr(addr, blndBalance, ts.asset.id);
      const swapHash = await signAndSubmitClassic(swapXdr, `Swap BLND → ${ts.asset.symbol}`);
      txStep(2);
      txHide();
      toast(`Converted ${fmt(blndBalance)} BLND → ~${estimate} ${ts.asset.symbol}`, "success", swapHash);
      await loadAll();
    } catch (e) {
      txStep(1, true);
      txHide();
      toast(txErr(e), "error");
    }
  }

  // ── Confirm-open modal (ports old-main confirmPositionModal gate) ─────────
  function confirmPositionModal(
    initial: number,
    leverage: number,
    liveAsset: AssetInfo,
    rs: ReserveStats | undefined,
  ): Promise<boolean> {
    const c = rs ? rs.cFactor : liveAsset.cFactor;
    const l = rs?.lFactor ?? 1;
    const hf = hfForLeverage(leverage, c, l);
    const supply = initial * leverage;
    const borrow = initial * (leverage - 1);
    let netApy = Number.NaN;
    if (rs) {
      const proj = projectRates(rs, supply, borrow);
      netApy = aprToApy(proj.netSupplyApr * leverage - proj.netBorrowCost * (leverage - 1));
    }

    return new Promise<boolean>((resolve) => {
      const overlay = el("div", { class: "trade-modal" });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        resolve(ok);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") done(false);
      };
      document.addEventListener("keydown", onKey);

      const row = (k: string, v: string, cls = "") =>
        el("div", { class: "trade-modal__row" }, [
          el("span", { class: "trade-modal__k" }, [k]),
          el("span", { class: `trade-mono trade-modal__v ${cls}` }, [v]),
        ]);

      const chk = el("input", { type: "checkbox", id: "trade-cp-understand" }) as HTMLInputElement;
      const confirmBtn = Button({ variant: "primary", children: "Confirm & Open" });
      confirmBtn.disabled = true;
      on(chk, "change", () => {
        confirmBtn.disabled = !chk.checked;
      });
      on(confirmBtn, "click", () => done(true));
      const cancelBtn = Button({ variant: "ghost", children: "Cancel" });
      on(cancelBtn, "click", () => done(false));

      const closeX = el("button", { class: "trade-modal__x", type: "button", "aria-label": "Close" }, ["✕"]);
      on(closeX, "click", () => done(false));

      const card = el("div", { class: "trade-modal__card", role: "dialog", "aria-modal": "true" }, [
        el("div", { class: "trade-modal__head" }, [
          el("h2", { class: "trade-modal__title" }, ["Review position"]),
          closeX,
        ]),
        el("div", { class: "trade-modal__body" }, [
          row("Leverage", `${leverage.toFixed(1)}×`),
          row("Deposit", `${fmt(initial)} ${liveAsset.symbol}`),
          row("Total collateral", `${fmt(supply)} ${liveAsset.symbol}`),
          row("Total borrowed", `${fmt(borrow)} ${liveAsset.symbol}`),
          row(
            "Health Factor",
            Number.isFinite(hf) ? fmt(hf, 4) : "∞",
            hf > 1.1 ? "trade-tone-up" : hf > 1.03 ? "trade-tone-warn" : "trade-tone-down",
          ),
          row(
            "Projected net APY",
            Number.isFinite(netApy) ? `${fmt(netApy)}%` : "—",
            Number.isFinite(netApy) ? (netApy >= 0 ? "trade-tone-up" : "trade-tone-down") : "",
          ),
          el("label", { class: "trade-modal__ack" }, [
            chk,
            el("span", {}, [
              "I understand this is a leveraged position and I can be liquidated, losing collateral.",
            ]),
          ]),
        ]),
        el("div", { class: "trade-modal__foot" }, [cancelBtn, confirmBtn]),
      ]);
      on(card, "click", (e) => e.stopPropagation());
      on(overlay, "click", () => done(false));
      overlay.append(card);
      document.body.append(overlay);
    });
  }

  // ── Small helpers ──────────────────────────────────────────────────────────
  function previewRow(k: HTMLElement | string, v: HTMLElement | string, cls = "", big = false): HTMLElement {
    return el("div", { class: "trade-prow" + (big ? " trade-prow--big" : "") }, [
      typeof k === "string" ? el("span", { class: "trade-prow__k" }, [k]) : k,
      typeof v === "string" ? el("span", { class: `trade-mono trade-prow__v ${cls}` }, [v]) : v,
    ]);
  }

  /** Friendly message for Blend error codes (mirrors old-main mapping). */
  function txErr(e: unknown): string {
    const msg = (e as Error)?.message ?? "Transaction failed";
    if (msg.includes("#1205") || msg.includes("InvalidHf")) return "Health factor too low — reduce leverage or deposit more.";
    if (msg.includes("#1207") || msg.includes("InvalidUtilRate")) return "Pool utilization limit reached — not enough liquidity.";
    return msg.slice(0, 200);
  }

  // React to Expert-mode toggles (changes min-HF → max leverage, the slider's
  // Maxi-degen zone, HF precision). Self-unsubscribes once this screen unmounts.
  let lastExpert = getState().expert;
  let wasMounted = false;
  const unsub = subscribe((s) => {
    const inDoc = document.contains(root);
    if (inDoc) wasMounted = true;
    else if (wasMounted) { unsub(); return; } // mounted then removed → clean up
    else return; // not mounted yet — ignore early state changes
    if (s.expert !== lastExpert) {
      lastExpert = s.expert;
      renderAll();
    }
  });

  // Initial paint + async fill.
  renderAll();
  void loadAll();

  return root;
}
