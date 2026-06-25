import "./swap.css";
/**
 * Swap screen — best-rate token swap routed via Stellar Broker, with a DEX Rate
 * (Aquarius) cross-check.
 *
 * Asset universe comes from the LOBSTR curated feed (see ./swapAssets), not a
 * hardcoded list: users browse or search (by code / name / domain / contract id)
 * to pick the sell + buy assets, with token logos. Slippage offers the three
 * presets plus a custom numeric input (0 < x ≤ 50, warned above 5%).
 *
 * EXECUTE: the broker trade-XDR builder is still unavailable, so the action
 * stays "coming soon" behind SWAP_EXECUTE_ENABLED — unchanged from before.
 */
import { el, on, Button, Tooltip, Modal } from "../ui";
import { estimateSwap } from "@stellar-broker/client";
import { aquariusBestRate } from "../aquarius";
import { fetchAssetBalance } from "../blend";
import { getState } from "../app/state";
import { signAndSubmitClassic } from "../app/wallet";
import { toast, txShow, txStep, txHide } from "../app/chrome";
import { t } from "../i18n";
import {
  loadSwapAssets,
  swapAssetsSync,
  searchSwapAssets,
  assetByBroker,
  symbolForBroker,
  contractForBroker,
  looksLikeContractId,
  type SwapAsset,
} from "./swapAssets";

// ── i18n helper: fall back to the literal when the key isn't translated ───────
const tx = (key: string, fallback: string) => {
  const v = t(key);
  return v === key ? fallback : v;
};

// Mount a modal overlay on <body>; returns a closer. Mirrors app/modals.ts.
function mountModal(node: HTMLElement | null): () => void {
  if (!node) return () => {};
  document.body.appendChild(node);
  return () => node.remove();
}

// EXECUTE TODO: gate the on-chain execute path. The broker trade-XDR build is not
// yet available (old-main.ts left it as "coming soon"); flip on once it lands.
const SWAP_EXECUTE_ENABLED = false;

const SLIPPAGE_PRESETS = ["0.1", "0.5", "1.0"];
const SLIP_MAX = 50; // hard cap (%)
const SLIP_WARN = 5; // warn above this (%)

type QuoteResult = Awaited<ReturnType<typeof estimateSwap>>;

interface SwapUiState {
  sell: string; // broker id
  buy: string; // broker id
  amount: string;
  slipPct: string; // effective slippage %, e.g. "0.5" or a custom "2.4"
  customSlip: boolean; // true when the Custom chip is selected
  quote: QuoteResult | null;
}

// ── Logo with a letter-avatar fallback ───────────────────────────────────────
function assetLogo(a: SwapAsset, size: number): HTMLElement {
  const wrap = el("span", {
    class: "tl-asset-logo",
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`,
  });
  const fallback = () => {
    wrap.textContent = (a.symbol[0] ?? "?").toUpperCase();
    wrap.classList.add("tl-asset-logo--text");
  };
  if (a.icon) {
    const img = el("img", {
      class: "tl-asset-logo__img",
      src: a.icon,
      alt: "",
      loading: "lazy",
      width: String(size),
      height: String(size),
    }) as HTMLImageElement;
    on(img, "error", fallback);
    wrap.appendChild(img);
  } else {
    fallback();
  }
  return wrap;
}

/** Build the Swap view. Renders immediately; quotes are fetched async on input. */
export function swapScreen(): HTMLElement {
  const root = el("div", { class: "tl-swap" });

  // The quote form renders and works whether or not a wallet is connected —
  // estimateSwap / aquariusBestRate need no address. Only the sell-side balance
  // hint and the (already quote-only) execute action gate on connect.

  const list = swapAssetsSync();
  const defaultSell = "XLM";
  const defaultBuy =
    list.find((a) => a.symbol === "USDC")?.brokerId ??
    list.find((a) => a.brokerId !== defaultSell)?.brokerId ??
    defaultSell;

  const ui: SwapUiState = {
    sell: defaultSell,
    buy: defaultBuy,
    amount: "",
    slipPct: "0.5",
    customSlip: false,
    quote: null,
  };

  root.replaceChildren(renderCard(ui));
  return root;
}

// ── Card ──────────────────────────────────────────────────────────────────────
function renderCard(ui: SwapUiState): HTMLElement {
  const slip = () => Number.parseFloat(ui.slipPct) / 100; // 0.5% → 0.005
  const slipOk = () => {
    const n = Number.parseFloat(ui.slipPct);
    return Number.isFinite(n) && n > 0 && n <= SLIP_MAX;
  };

  // Field refs we mutate in place (no React; imperative DOM updates).
  const receiveEl = el("div", { class: "tl-swap__receive tl-swap__receive--ph" }, ["0.0"]);
  const sellBalEl = el("span", { class: "tl-swap__bal" }, ["—"]);
  const well = el("div", { class: "tl-swap__well", style: "display:none" });

  let quoteTimer: ReturnType<typeof setTimeout> | null = null;
  let aqSeq = 0; // guards out-of-order Aquarius responses

  const amountInput = el("input", {
    class: "tl-input__field",
    type: "text",
    inputmode: "decimal",
    placeholder: "0.0",
    value: ui.amount,
  }) as HTMLInputElement;
  const amountField = el("div", { class: "tl-input" }, [amountInput]);

  // ── Quote button (primary action) ──────────────────────────────────────────
  const actionBtn = Button({
    variant: "primary",
    size: "lg",
    fullWidth: true,
    disabled: true,
    children: [tx("swap.getQuote", "Get Quote")],
    onClick: () => void onAction(),
  });

  // ── Asset pills (open the searchable picker) ────────────────────────────────
  const sellPill = assetPill("sell");
  const buyPill = assetPill("buy");

  function assetPill(side: "sell" | "buy"): HTMLButtonElement {
    const btn = el("button", {
      class: "tl-swap__pill",
      type: "button",
      "aria-haspopup": "dialog",
    }) as HTMLButtonElement;
    on(btn, "click", () => openAssetPicker(side));
    paintPill(btn, side);
    return btn;
  }

  function paintPill(btn: HTMLButtonElement, side: "sell" | "buy"): void {
    const brokerId = side === "sell" ? ui.sell : ui.buy;
    const a = assetByBroker(brokerId);
    btn.replaceChildren(
      a ? assetLogo(a, 22) : el("span", { class: "tl-asset-logo tl-asset-logo--text", style: "width:22px;height:22px" }, ["?"]),
      el("span", { class: "tl-swap__pill-code" }, [symbolForBroker(brokerId)]),
      el("span", { class: "tl-swap__caret", "aria-hidden": "true" }, ["▾"]),
    );
  }

  function repaintPills(): void {
    paintPill(sellPill, "sell");
    paintPill(buyPill, "buy");
  }

  // ── Searchable asset picker (modal) ─────────────────────────────────────────
  function openAssetPicker(side: "sell" | "buy"): void {
    let close = () => {};
    const input = el("input", {
      class: "tl-ap__input",
      type: "text",
      placeholder: tx("swap.searchAssets", "Search name, code, or contract id…"),
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    const listEl = el("div", { class: "tl-ap__list" });

    const renderList = (q: string) => {
      const items = searchSwapAssets(swapAssetsSync(), q);
      if (!items.length) {
        listEl.replaceChildren(
          el("div", { class: "tl-ap__empty" }, [
            looksLikeContractId(q)
              ? tx("swap.noContract", "That contract id isn’t in the curated list.")
              : tx("swap.noMatch", "No assets match your search."),
          ]),
        );
        return;
      }
      listEl.replaceChildren(
        ...items.slice(0, 200).map((a) => assetRow(a, side, () => {
          pickAsset(side, a.brokerId);
          close();
        })),
      );
    };

    on(input, "input", () => renderList(input.value));
    renderList("");

    const node = Modal({
      open: true,
      title: side === "sell" ? tx("swap.selectSell", "Select asset to sell") : tx("swap.selectBuy", "Select asset to receive"),
      width: 440,
      onClose: () => close(),
      children: el("div", { class: "tl-ap" }, [
        el("div", { class: "tl-ap__search" }, [input]),
        listEl,
      ]),
    });
    close = mountModal(node);
    input.focus();
    // The fetch may still be resolving — refresh the list once it lands.
    void loadSwapAssets().then(() => {
      if (node?.isConnected) {
        repaintPills();
        renderList(input.value);
      }
    });
  }

  function assetRow(a: SwapAsset, side: "sell" | "buy", onPick: () => void): HTMLElement {
    const otherId = side === "sell" ? ui.buy : ui.sell;
    const selectedId = side === "sell" ? ui.sell : ui.buy;
    const row = el("button", {
      class: "tl-ap__row" + (a.brokerId === selectedId ? " is-selected" : ""),
      type: "button",
    }, [
      assetLogo(a, 30),
      el("span", { class: "tl-ap__meta" }, [
        el("span", { class: "tl-ap__code" }, [a.symbol, a.brokerId === otherId ? el("span", { class: "tl-ap__tag" }, ["other side"]) : null]),
        el("span", { class: "tl-ap__name" }, [a.name + (a.domain ? ` · ${a.domain}` : "")]),
      ]),
    ]) as HTMLButtonElement;
    on(row, "click", onPick);
    return row;
  }

  function pickAsset(side: "sell" | "buy", brokerId: string): void {
    // Picking the asset already on the other side swaps the pair (no dupes).
    if (side === "sell") {
      if (brokerId === ui.buy) ui.buy = ui.sell;
      ui.sell = brokerId;
    } else {
      if (brokerId === ui.sell) ui.sell = ui.buy;
      ui.buy = brokerId;
    }
    ui.quote = null;
    repaintPills();
    void refreshBalance();
    scheduleQuote();
  }

  // ── Reverse ─────────────────────────────────────────────────────────────────
  const reverseBtn = el(
    "button",
    { class: "tl-swap__reverse", type: "button", title: tx("swap.reverse", "Reverse pair"), "aria-label": tx("swap.reverse", "Reverse pair") },
    ["↓"],
  ) as HTMLButtonElement;
  on(reverseBtn, "click", () => {
    const tmp = ui.sell;
    ui.sell = ui.buy;
    ui.buy = tmp;
    ui.quote = null;
    repaintPills();
    void refreshBalance();
    scheduleQuote();
  });

  // ── Amount input ─────────────────────────────────────────────────────────────
  on(amountInput, "input", () => {
    // Strip everything that isn't a digit or a dot (matches old-main.ts).
    const cleaned = amountInput.value.replace(/[^\d.]/g, "");
    if (cleaned !== amountInput.value) amountInput.value = cleaned;
    ui.amount = cleaned;
    ui.quote = null;
    scheduleQuote();
  });

  // ── Slippage: presets + Custom ──────────────────────────────────────────────
  const slipChips: HTMLButtonElement[] = [];
  const customChip = el("button", { class: "tl-swap__chip", type: "button" }, [tx("swap.custom", "Custom")]) as HTMLButtonElement;
  const customInput = el("input", {
    class: "tl-swap__slip-input",
    type: "text",
    inputmode: "decimal",
    placeholder: "2.5",
    "aria-label": tx("swap.customSlippage", "Custom slippage %"),
  }) as HTMLInputElement;
  const customPctSign = el("span", { class: "tl-swap__slip-pct" }, ["%"]);
  const customWrap = el("div", { class: "tl-swap__slip-custom", style: "display:none" }, [customInput, customPctSign]);
  const slipWarn = el("div", { class: "tl-swap__slip-warn", style: "display:none" }, []);

  for (const s of SLIPPAGE_PRESETS) {
    const chip = el("button", { class: "tl-swap__chip", type: "button" }, [`${s}%`]) as HTMLButtonElement;
    on(chip, "click", () => {
      ui.customSlip = false;
      ui.slipPct = s;
      customWrap.style.display = "none";
      paintSlip();
      ui.quote = null;
      scheduleQuote();
    });
    slipChips.push(chip);
  }

  on(customChip, "click", () => {
    ui.customSlip = true;
    if (!customInput.value) customInput.value = ui.slipPct;
    ui.slipPct = customInput.value;
    customWrap.style.display = "";
    paintSlip();
    customInput.focus();
    customInput.select();
    ui.quote = null;
    scheduleQuote();
  });

  on(customInput, "input", () => {
    const cleaned = customInput.value.replace(/[^\d.]/g, "");
    if (cleaned !== customInput.value) customInput.value = cleaned;
    ui.slipPct = cleaned;
    ui.quote = null;
    paintSlip();
    scheduleQuote();
  });

  function paintSlip(): void {
    slipChips.forEach((c, i) => c.classList.toggle("is-active", !ui.customSlip && ui.slipPct === SLIPPAGE_PRESETS[i]));
    customChip.classList.toggle("is-active", ui.customSlip);
    const n = Number.parseFloat(ui.slipPct);
    let warn = "";
    let bad = false;
    if (ui.customSlip) {
      if (!ui.slipPct || !Number.isFinite(n) || n <= 0 || n > SLIP_MAX) {
        bad = true;
        warn = tx("swap.slipRange", `Enter a slippage between 0 and ${SLIP_MAX}%.`);
      } else if (n > SLIP_WARN) {
        warn = tx("swap.slipHigh", "High slippage — you may receive significantly less than quoted.");
      }
    }
    customInput.classList.toggle("is-invalid", bad);
    slipWarn.textContent = warn;
    slipWarn.classList.toggle("is-error", bad);
    slipWarn.style.display = warn ? "" : "none";
    updateWellSlip();
  }

  // ── Quote well rows ──────────────────────────────────────────────────────────
  const rateVal = el("span", { class: "tl-swap__qrow-v" }, ["—"]);
  const dexVal = el("span", { class: "tl-swap__qrow-v" }, ["—"]);
  const advVal = el("span", { class: "tl-swap__qrow-v tl-swap__qrow-v--good" }, ["—"]);
  const slipVal = el("span", { class: "tl-swap__qrow-v" }, [`${ui.slipPct}%`]);

  well.replaceChildren(
    qrow(tx("swap.rate", "Rate"), "The effective price you get for this swap via the best routed path.", rateVal),
    qrow("DEX Rate", "For comparison: the direct quote on the Stellar DEX (Aquarius), without broker routing.", dexVal, true),
    qrow(tx("swap.brokerAdvantage", "Broker advantage"), "How much better the broker’s routed rate is versus a direct DEX trade.", advVal),
    qrow(tx("swap.slippage", "Slippage tolerance"), "The maximum price movement you’ll accept before the swap fails. Lower is stricter but more likely to revert in volatile markets.", slipVal, true),
  );

  function updateWellSlip() {
    slipVal.textContent = `${ui.slipPct || "0"}%`;
  }

  // ── Balance ──────────────────────────────────────────────────────────────────
  async function refreshBalance() {
    const addr = getState().userAddress;
    const contractId = contractForBroker(ui.sell);
    if (!addr || !contractId) {
      sellBalEl.textContent = "—";
      return;
    }
    try {
      const bal = await fetchAssetBalance(addr, contractId);
      sellBalEl.textContent = `${bal.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symbolForBroker(ui.sell)}`;
    } catch {
      sellBalEl.textContent = "—";
    }
  }

  // ── Button state machine ─────────────────────────────────────────────────────
  function updateButton() {
    const hasAmount = !!ui.amount && Number.parseFloat(ui.amount) > 0;
    const samePair = ui.sell === ui.buy;
    if (samePair) {
      setBtn(tx("swap.selectDifferent", "Select a different pair"), true);
    } else if (!hasAmount) {
      setBtn(tx("swap.enterAmount", "Enter an amount"), true);
    } else if (ui.customSlip && !slipOk()) {
      setBtn(tx("swap.slipRange", `Enter a slippage between 0 and ${SLIP_MAX}%.`), true);
    } else if (ui.quote && ui.quote.status === "success") {
      if (!getState().userAddress) {
        setBtn(tx("nav.connect", "Connect Wallet"), true);
      } else {
        setBtn(
          SWAP_EXECUTE_ENABLED ? tx("swap.execute", "Swap") : tx("swap.comingSoon", "Execution coming soon"),
          !SWAP_EXECUTE_ENABLED,
        );
      }
    } else {
      setBtn(tx("swap.getQuote", "Get Quote"), false);
    }
  }
  function setBtn(label: string, disabled: boolean) {
    actionBtn.textContent = label;
    actionBtn.disabled = disabled;
  }

  // ── Quote fetch (estimateSwap) ───────────────────────────────────────────────
  function scheduleQuote() {
    updateButton();
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => void fetchQuote(), 500);
  }

  async function fetchQuote() {
    const { sell, buy, amount } = ui;
    if (!amount || Number.parseFloat(amount) <= 0 || sell === buy || !slipOk()) {
      ui.quote = null;
      hideWell();
      setReceive("0.0", true);
      updateButton();
      return;
    }
    try {
      const quote = await estimateSwap({
        sellingAsset: sell,
        buyingAsset: buy,
        sellingAmount: amount,
        slippageTolerance: slip(),
      });
      // Discard if inputs changed while the request was in flight.
      if (ui.sell !== sell || ui.buy !== buy || ui.amount !== amount) return;
      ui.quote = quote;

      if (quote.status === "success" && quote.estimatedBuyingAmount) {
        const sellNum = Number.parseFloat(amount);
        const buyNum = Number.parseFloat(quote.estimatedBuyingAmount);
        const sellSym = symbolForBroker(sell);
        const buySym = symbolForBroker(buy);

        setReceive(buyNum.toLocaleString("en-US", { maximumFractionDigits: 4 }), false);
        rateVal.textContent = `1 ${sellSym} ≈ ${(buyNum / sellNum).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${buySym}`;
        advVal.textContent = quote.profit && Number.parseFloat(quote.profit) > 0
          ? `+${Number.parseFloat(quote.profit).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${buySym}`
          : "—";
        showWell();
        void compareDexRate(sell, buy, sellNum, buySym);
      } else {
        ui.quote = null;
        setReceive(quote.status === "unfeasible" ? "No route" : "—", true);
        hideWell();
      }
    } catch (e) {
      if (ui.sell !== sell || ui.buy !== buy || ui.amount !== amount) return;
      ui.quote = null;
      setReceive("Quote unavailable", true);
      hideWell();
      console.warn("Swap quote:", e instanceof Error ? e.message : String(e));
    }
    updateButton();
  }

  // ── DEX (Aquarius) comparison ────────────────────────────────────────────────
  async function compareDexRate(sellBrokerId: string, buyBrokerId: string, sellNum: number, buySym: string) {
    const seq = ++aqSeq;
    const sellC = contractForBroker(sellBrokerId);
    const buyC = contractForBroker(buyBrokerId);
    if (!sellC || !buyC) {
      if (seq === aqSeq) {
        dexVal.textContent = tx("common.na", "N/A");
        dexVal.title = "No DEX route for this pair";
      }
      return;
    }
    const amountStroops = BigInt(Math.round(sellNum * 1e7));
    const aq = await aquariusBestRate(sellC, buyC, amountStroops);
    if (seq !== aqSeq) return; // a newer quote superseded this one
    if (!aq) {
      dexVal.textContent = tx("common.unavailable", "unavailable");
      dexVal.removeAttribute("title");
      return;
    }
    const aqOut = Number(aq.amountOut) / 1e7;
    dexVal.textContent = `${aqOut.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${buySym}`;
    dexVal.removeAttribute("title");
  }

  // ── Receive / well helpers ───────────────────────────────────────────────────
  function setReceive(text: string, placeholder: boolean) {
    receiveEl.textContent = text;
    receiveEl.classList.toggle("tl-swap__receive--ph", placeholder);
  }
  function showWell() {
    well.style.display = "";
  }
  function hideWell() {
    well.style.display = "none";
  }

  // ── Primary action: Get Quote OR (TODO) execute ──────────────────────────────
  async function onAction() {
    if (!ui.quote || ui.quote.status !== "success") {
      if (quoteTimer) clearTimeout(quoteTimer);
      await fetchQuote();
      return;
    }
    await executeSwap();
  }

  // ── EXECUTE (TODO) ───────────────────────────────────────────────────────────
  // The broker trade-XDR builder is not available yet; the button stays disabled
  // on a success quote until SWAP_EXECUTE_ENABLED is flipped on with a real
  // builder. The TxStepper + sign/submit scaffold below is ready for that.
  async function executeSwap() {
    if (!SWAP_EXECUTE_ENABLED) {
      toast(tx("swap.comingSoon", "Swap execution is coming soon."), "info");
      return;
    }
    const addr = getState().userAddress;
    if (!addr || !ui.quote || ui.quote.status !== "success") return;

    const steps = [
      tx("tx.build", "Build"),
      tx("tx.sign", "Sign"),
      tx("tx.submit", "Submit"),
      tx("tx.confirmed", "Confirmed"),
    ];
    txShow(steps);
    try {
      txStep(0);
      const xdr = ""; // placeholder — no builder available yet
      if (!xdr) throw new Error("Swap execution not yet implemented");

      txStep(1);
      const hash = await signAndSubmitClassic(xdr, `Swap ${symbolForBroker(ui.sell)} → ${symbolForBroker(ui.buy)}`);
      txStep(steps.length);
      toast(tx("swap.done", "Swap submitted."), "success", hash);
      txHide();
      void refreshBalance();
    } catch (e) {
      txStep(steps.length - 1, true);
      toast(e instanceof Error ? e.message : String(e), "error");
      txHide();
    }
  }

  // ── Layout ────────────────────────────────────────────────────────────────────
  const card = el("div", { class: "tl-swap__card" }, [
    // Header
    el("div", { class: "tl-swap__head" }, [
      el("h2", { class: "tl-swap__title" }, [tx("swap.title", "Swap")]),
      el("span", { class: "tl-swap__via" }, [
        tx("swap.via", "via Stellar Broker"),
        Tooltip({ text: "Swaps route through Stellar Broker, which aggregates the best path across Stellar DEXes (including Aquarius) for the best execution." }),
      ]),
    ]),

    // You sell
    el("div", { class: "tl-swap__label-row" }, [
      el("label", { class: "tl-swap__label" }, [tx("swap.youSell", "You sell")]),
      sellBalEl,
    ]),
    el("div", { class: "tl-swap__row" }, [amountField, sellPill]),

    // Reverse
    el("div", { class: "tl-swap__reverse-wrap" }, [reverseBtn]),

    // You receive
    el("label", { class: "tl-swap__label" }, [tx("swap.youReceive", "You receive (estimated)")]),
    el("div", { class: "tl-swap__row" }, [receiveEl, buyPill]),

    // Quote well
    well,

    // Slippage presets + Custom
    el("div", { class: "tl-swap__slip" }, [
      el("span", { class: "tl-swap__slip-label" }, [tx("swap.slippageShort", "Slippage")]),
      ...slipChips,
      customChip,
      customWrap,
    ]),
    slipWarn,

    // Primary action
    actionBtn,

    // Footnote
    el("p", { class: "tl-swap__foot" }, [
      "Swaps are executed through ",
      el("strong", {}, ["Stellar Broker"]),
      " for best-route aggregation across Stellar DEXes. Asset list curated by ",
      el("strong", {}, ["LOBSTR"]),
      ".",
    ]),
  ]);

  // Initial async fills.
  paintSlip();
  void refreshBalance();
  updateButton();
  // Pull the curated list; repaint pills (logos) once it lands.
  void loadSwapAssets().then(() => repaintPills());

  return el("div", { class: "tl-swap__wrap" }, [card]);
}

// ── Quote-well row ──────────────────────────────────────────────────────────────
function qrow(label: string, tip: string, valueEl: HTMLElement, dim = false): HTMLElement {
  return el("div", { class: `tl-swap__qrow${dim ? " tl-swap__qrow--dim" : ""}` }, [
    el("span", { class: "tl-swap__qrow-k" }, [label, Tooltip({ text: tip })]),
    valueEl,
  ]);
}
