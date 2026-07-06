import "./swap.css";
/**
 * Swap screen — best-rate token swap routed via Stellar Broker, with a DEX Rate
 * (Aquarius) cross-check.
 *
 * Data wiring ported 1:1 from /tmp/old-main.ts:
 *   - SWAP_ASSETS                    → dynamically loaded from swapAssets.ts
 *   - populateSwapAssets()           → Select option seeding + XLM→USDC defaults
 *   - fetchSwapQuote() + debounce    → estimateSwap() from @stellar-broker/client
 *   - compareAquariusRate()          → aquariusBestRate() from ../aquarius (DEX Rate well)
 *   - refreshBalance()               → fetchAssetBalance() from ../blend
 *
 * EXECUTE: the original never implemented an execute path — its swap button shows
 * "coming soon" and stays disabled. There is no swap-build/sign/submit XDR in
 * old-main.ts. So per the brief the quote is wired fully and execute is marked
 * TODO: the TxStepper + signAndSubmit scaffold is in place behind SWAP_EXECUTE_ENABLED
 * but the broker trade-XDR build is not yet available. See executeSwap() below.
 */
import { el, on, Button, Select, Tooltip } from "../ui";
import { estimateSwap } from "@stellar-broker/client";
import { aquariusBestRate } from "../aquarius";
import { fetchAssetBalance } from "../blend";
import { getState } from "../app/state";
import { signAndSubmitClassic } from "../app/wallet";
import { toast, txShow, txStep, txHide } from "../app/chrome";
import { t } from "../i18n";
import {
  loadSwapAssets,
  type SwapAsset,
} from "./swapAssets";

let SWAP_ASSETS: SwapAsset[] = [];

const symbolFor = (brokerId: string) =>
  SWAP_ASSETS.find((a) => a.brokerId === brokerId)?.symbol ??
  brokerId;

const contractFor = (brokerId: string) =>
  SWAP_ASSETS.find((a) => a.brokerId === brokerId)
    ?.contractId;

// ── i18n helper: fall back to the literal when the key isn't translated ───────
const tx = (key: string, fallback: string) => {
  const v = t(key);
  return v === key ? fallback : v;
};

// EXECUTE TODO: gate the on-chain execute path. The broker trade-XDR build is not
// yet available (old-main.ts left it as "coming soon"); flip on once it lands.
const SWAP_EXECUTE_ENABLED = false;

const SLIPPAGE_CHIPS = [
  "0.1",
  "0.5",
  "1.0",
  "custom",
];

type QuoteResult = Awaited<ReturnType<typeof estimateSwap>>;

interface SwapUiState {
  sell: string;
  buy: string;
  amount: string;
  slipPct: string; // "0.1" | "0.5" | "1.0" or custom numeric string
  quote: QuoteResult | null;
}

let assetsLoaded = false;

/** Build the Swap view. Renders immediately; quotes are fetched async on input. */
export function swapScreen(): HTMLElement {
  const root = el("div", { class: "tl-swap" });

  if (!assetsLoaded) {
    root.replaceChildren(
      el("div", { class: "tl-swap__loading" }, [
        "Loading assets...",
      ]),
    );

    void loadSwapAssets()
      .then((assets) => {
        SWAP_ASSETS = assets;
        assetsLoaded = true;

        root.replaceChildren(renderCard({
          sell:
            assets.find((a) => a.symbol === "XLM")?.brokerId ??
            assets[0]?.brokerId ??
            "XLM",
          buy:
            assets.find((a) => a.symbol === "USDC")?.brokerId ??
            assets[1]?.brokerId ??
            assets[0].brokerId,
          amount: "",
          slipPct: "0.5",
          quote: null,
        }, root));
      })
      .catch((err) => {
        console.error("Failed to load swap assets", err);

        root.replaceChildren(
          el("div", { class: "tl-swap__error" }, [
            "Failed to load assets",
          ]),
        );
      });

    return root;
  }

  // The quote form renders and works whether or not a wallet is connected —
  // estimateSwap / aquariusBestRate need no address. Only the sell-side balance
  // hint and the (already quote-only) execute action gate on connect. Mirrors
  // trade.ts: public data shows; wallet-specific bits gate.

  const list = SWAP_ASSETS;

  const defaultSell =
    list.find((a) => a.symbol === "XLM")?.brokerId ??
    list[0]?.brokerId ??
    "XLM";

  const defaultBuy =
    list.find((a) => a.symbol === "USDC")?.brokerId ??
    list.find((a) => a.brokerId !== defaultSell)?.brokerId ??
    defaultSell;

  const ui: SwapUiState = {
    sell: defaultSell,
    buy: defaultBuy,
    amount: "",
    slipPct: "0.5",
    quote: null,
  };

  root.replaceChildren(renderCard(ui, root));

  return root;
}

// ── Card ────────────────────────────────────────────────────────────────────
function renderCard(ui: SwapUiState, root: HTMLElement): HTMLElement {
  const slip = () => Number.parseFloat(ui.slipPct) / 100; // 0.5% → 0.005

  // Field refs we mutate in place (no React; imperative DOM updates).
  const receiveEl = el("div", { class: "tl-swap__receive tl-swap__receive--ph" }, ["0.0"]);
  const sellBalEl = el("span", { class: "tl-swap__bal" }, ["—"]);
  const well = el("div", { class: "tl-swap__well", style: "display:none" });
  const slipChips: HTMLButtonElement[] = [];
  const customSlipInput = el("input", {
    class: "tl-swap__custom-slip",
    type: "number",
    min: "0.01",
    max: "50",
    step: "0.1",
    placeholder: "Custom %",
    style: "display:none",
  }) as HTMLInputElement;

  const slipWarning = el(
    "div",
    {
      class: "tl-swap__slip-warning",
      style: "display:none",
    },
    ["High slippage warning (>5%)"],
  );

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

  // ── Asset selects ──────────────────────────────────────────────────────────
  const assetOptions = SWAP_ASSETS.map((a) => ({ value: a.brokerId, label: a.symbol }));
  const sellSelect = Select({
    options: assetOptions,
    value: ui.sell,
    width: 120,
    onChange: (v) => {
      ui.sell = v;
      ui.quote = null;
      void refreshBalance();
      scheduleQuote();
    },
  });
  const buySelect = Select({
    options: assetOptions,
    value: ui.buy,
    width: 120,
    onChange: (v) => {
      ui.buy = v;
      ui.quote = null;
      scheduleQuote();
    },
  });

  // ── Reverse ──────────────────────────────────────────────────────────────
  const reverseBtn = el(
    "button",
    { class: "tl-swap__reverse", type: "button", title: tx("swap.reverse", "Reverse pair"), "aria-label": tx("swap.reverse", "Reverse pair") },
    ["↓"],
  ) as HTMLButtonElement;
  on(reverseBtn, "click", () => {
    const tmp = ui.sell;
    ui.sell = ui.buy;
    ui.buy = tmp;
    sellSelect.value = ui.sell;
    buySelect.value = ui.buy;
    ui.quote = null;
    void refreshBalance();
    scheduleQuote();
  });

  // ── Amount input ──────────────────────────────────────────────────────────
  on(amountInput, "input", () => {
    // Strip everything that isn't a digit or a dot (matches old-main.ts).
    const cleaned = amountInput.value.replace(/[^\d.]/g, "");
    if (cleaned !== amountInput.value) amountInput.value = cleaned;
    ui.amount = cleaned;
    ui.quote = null;
    scheduleQuote();
  });

  // ── Slippage chips ────────────────────────────────────────────────────────
  for (const s of SLIPPAGE_CHIPS) {
    const label =
      s === "custom" ? "Custom" : `${s}%`;
    const chip = el(
      "button",
      { class: `tl-swap__chip${s === ui.slipPct ? " is-active" : ""}`, type: "button" },
      [label],
    ) as HTMLButtonElement;
    on(chip, "click", () => {
      if (s === "custom") {
        customSlipInput.style.display = "";
        customSlipInput.focus();
        return;
      }

      customSlipInput.style.display = "none";
      ui.slipPct = s;
      slipChips.forEach((c) => c.classList.toggle("is-active", c === chip));
      updateWellSlip();
      ui.quote = null;
      scheduleQuote();
    });
    slipChips.push(chip);
  }

  on(customSlipInput, "input", () => {
    const value = Number(customSlipInput.value);

    if (
      Number.isNaN(value) ||
      value <= 0 ||
      value > 50
    ) {
      return;
    }

    ui.slipPct = String(value);

    slipWarning.style.display =
      value > 5 ? "" : "none";

    updateWellSlip();

    ui.quote = null;
    scheduleQuote();
  });

  // ── Quote well rows ───────────────────────────────────────────────────────
  const rateVal = el("span", { class: "tl-swap__qrow-v" }, ["—"]);
  const dexVal = el("span", { class: "tl-swap__qrow-v" }, ["—"]);
  const advVal = el("span", { class: "tl-swap__qrow-v tl-swap__qrow-v--good" }, ["—"]);
  const slipVal = el("span", { class: "tl-swap__qrow-v" }, [`${ui.slipPct}%`]);

  well.replaceChildren(
    qrow(
      tx("swap.rate", "Rate"),
      "The effective price you get for this swap via the best routed path.",
      rateVal,
    ),
    qrow(
      "DEX Rate",
      "For comparison: the direct quote on the Stellar DEX (Aquarius), without broker routing.",
      dexVal,
      true,
    ),
    qrow(
      tx("swap.brokerAdvantage", "Broker advantage"),
      "How much better the broker's routed rate is versus a direct DEX trade.",
      advVal,
    ),
    qrow(
      tx("swap.slippage", "Slippage tolerance"),
      "The maximum price movement you'll accept before the swap fails. Lower is stricter but more likely to revert in volatile markets.",
      slipVal,
      true,
    ),
  );

  function updateWellSlip() {
    slipVal.textContent = `${ui.slipPct}%`;
  }

  // ── Balance ───────────────────────────────────────────────────────────���──
  async function refreshBalance() {
    const addr = getState().userAddress;
    const contractId = contractFor(ui.sell);
    if (!addr || !contractId) {
      sellBalEl.textContent = "—";
      return;
    }
    try {
      const bal = await fetchAssetBalance(addr, contractId);
      sellBalEl.textContent = `${bal.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symbolFor(ui.sell)}`;
    } catch {
      sellBalEl.textContent = "—";
    }
  }

  // ── Button state machine ──────────────────────────────────────────────────
  function updateButton() {
    const hasAmount = !!ui.amount && Number.parseFloat(ui.amount) > 0;
    const samePair = ui.sell === ui.buy;
    if (samePair) {
      setBtn(tx("swap.selectDifferent", "Select a different pair"), true);
    } else if (!hasAmount) {
      setBtn(tx("swap.enterAmount", "Enter an amount"), true);
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

  // ── Quote fetch ────────────────────────────────────────────────────────────
  function scheduleQuote() {
    updateButton();
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => void fetchQuote(), 500);
  }

  async function fetchQuote() {
    const { sell, buy, amount } = ui;
    if (!amount || Number.parseFloat(amount) <= 0 || sell === buy) {
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
      if (ui.sell !== sell || ui.buy !== buy || ui.amount !== amount) return;
      ui.quote = quote;

      if (quote.status === "success" && quote.estimatedBuyingAmount) {
        const sellNum = Number.parseFloat(amount);
        const buyNum = Number.parseFloat(quote.estimatedBuyingAmount);
        const sellSym = symbolFor(sell);
        const buySym = symbolFor(buy);

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

  // ── DEX (Aquarius) comparison ──────────────────────────────────────────────
  async function compareDexRate(
    sellBrokerId: string,
    buyBrokerId: string,
    sellNum: number,
    buySym: string,
  ) {
    const seq = ++aqSeq;
    const sellC = contractFor(sellBrokerId);
    const buyC = contractFor(buyBrokerId);
    if (!sellC || !buyC) {
      if (seq === aqSeq) {
        dexVal.textContent = tx("common.na", "N/A");
        dexVal.title = "No DEX route for this pair";
      }
      return;
    }
    const amountStroops = BigInt(Math.round(sellNum * 1e7));
    const aq = await aquariusBestRate(sellC, buyC, amountStroops);
    if (seq !== aqSeq) return;
    if (!aq) {
      dexVal.textContent = tx("common.unavailable", "unavailable");
      dexVal.removeAttribute("title");
      return;
    }
    const aqOut = Number(aq.amountOut) / 1e7;
    dexVal.textContent = `${aqOut.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${buySym}`;
    dexVal.removeAttribute("title");
  }

  // ── Receive / well helpers ───────────────────────────────────────────────
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

  // ── Primary action ─────────────────────────────────────────────────────────
  async function onAction() {
    if (!ui.quote || ui.quote.status !== "success") {
      if (quoteTimer) clearTimeout(quoteTimer);
      await fetchQuote();
      return;
    }
    await executeSwap();
  }

  // ── EXECUTE (TODO) ─────────────────────────────────────────────────────────
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
      const xdr = "";
      if (!xdr) throw new Error("Swap execution not yet implemented");

      txStep(1);
      const hash = await signAndSubmitClassic(xdr, `Swap ${symbolFor(ui.sell)} → ${symbolFor(ui.buy)}`);
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

  // ── Layout ─────────────────────────────────────────────────────────────────
  const card = el("div", { class: "tl-swap__card" }, [
    el("div", { class: "tl-swap__head" }, [
      el("h2", { class: "tl-swap__title" }, [tx("swap.title", "Swap")]),
      el("span", { class: "tl-swap__via" }, [
        tx("swap.via", "via Stellar Broker"),
        Tooltip({
          text: "Swaps route through Stellar Broker, which aggregates the best path across Stellar DEXes (including Aquarius) for the best execution.",
        }),
      ]),
    ]),

    el("div", { class: "tl-swap__label-row" }, [
      el("label", { class: "tl-swap__label" }, [tx("swap.youSell", "You sell")]),
      sellBalEl,
    ]),
    el("div", { class: "tl-swap__row" }, [amountField, sellSelect]),

    el("div", { class: "tl-swap__reverse-wrap" }, [reverseBtn]),

    el("label", { class: "tl-swap__label" }, [tx("swap.youReceive", "You receive (estimated)")]),
    el("div", { class: "tl-swap__row" }, [receiveEl, buySelect]),

    well,

    el("div", { class: "tl-swap__slip" }, [
      el("span", { class: "tl-swap__slip-label" }, [
        tx("swap.slippageShort", "Slippage"),
      ]),
      ...slipChips,
      customSlipInput,
    ]),

    slipWarning,

    actionBtn,

    el("p", { class: "tl-swap__foot" }, [
      "Swaps are executed through ",
      el("strong", {}, ["Stellar Broker"]),
      " for best-route aggregation across Stellar DEXes.",
    ]),
  ]);

  void refreshBalance();
  updateButton();

  return el("div", { class: "tl-swap__wrap" }, [card]);
}

// ── Quote-well row ────────────────────────────────────────────────────────
function qrow(label: string, tip: string, valueEl: HTMLElement, dim = false): HTMLElement {
  return el("div", { class: `tl-swap__qrow${dim ? " tl-swap__qrow--dim" : ""}` }, [
    el("span", { class: "tl-swap__qrow-k" }, [label, Tooltip({ text: tip })]),
    valueEl,
  ]);
}
