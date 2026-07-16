import "./swap.css";
/**
 * Swap screen — best-rate token swap routed via Stellar Broker, with a DEX Rate
 * (Aquarius) cross-check.
 *
 * Data wiring ported from /tmp/old-main.ts:
 *   - asset list                         → ../swap-assets (top 50 by stellar.expert
 *     rating, 24h cache, static fallback; contract IDs derived via Asset.contractId)
 *   - populateSwapAssets()               → Select option seeding + XLM→USDC defaults
 *   - fetchSwapQuote() + debounce        → estimateSwap() from @stellar-broker/client
 *   - compareAquariusRate()              → aquariusBestRate() from ../aquarius (DEX Rate well)
 *   - updateSwapBalance()                → fetchAssetBalance() from ../blend
 *
 * EXECUTE: implemented through the Stellar Broker mediator flow (mainnet only —
 * api.stellar.broker trades against the public network). The user signs a single
 * classic tx that creates + funds a temporary mediator account; the broker
 * session then trades autonomously with the mediator's local keypair (no wallet
 * popup per fill), and dispose() merges all proceeds + unused reserves back into
 * the user's account. See executeSwap() below.
 */
import { el, on, Button, Select, Tooltip } from "../ui";
import { estimateSwap, StellarBrokerClient, Mediator } from "@stellar-broker/client";
import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { aquariusBestRate } from "../aquarius";
import { fetchAssetBalance, getActiveNetwork } from "../blend";
import { getState } from "../app/state";
import { signXdr } from "../app/wallet";
import { toast, txShow, txStep, txHide } from "../app/chrome";
import { t } from "../i18n";
import { getSwapAssets, FALLBACK_SWAP_ASSETS, type SwapAsset } from "../swap-assets";

// ── i18n helper: fall back to the literal when the key isn't translated ───────
const tx = (key: string, fallback: string) => {
  const v = t(key);
  return v === key ? fallback : v;
};

// Stellar Broker trades against the public network only (api.stellar.broker and
// the mediator's Horizon endpoint are both hardcoded to mainnet in the client).
const swapExecuteAvailable = () => getActiveNetwork() === "mainnet";

// ── Broker connection ─────────────────────────────────────────────────────────
// In production the broker WebSocket goes through our Cloudflare worker relay
// (GET /broker/ws), which injects the partner key server-side so it never ships
// in this bundle. For local testing you can bypass the relay by setting
// VITE_STELLAR_BROKER_PARTNER_KEY, which connects straight to api.stellar.broker.
const DEV_PARTNER_KEY = import.meta.env.VITE_STELLAR_BROKER_PARTNER_KEY as string | undefined;
const BROKER_RELAY_ORIGIN = `${
  (import.meta.env.VITE_ALERTS_WORKER_URL as string | undefined) ?? "https://turbolong-alerts.turbolong.workers.dev"
}/broker`;

/** Build a broker client wired either to the relay (prod) or directly (dev). */
function createBrokerClient(): StellarBrokerClient {
  const client = new StellarBrokerClient({ partnerKey: DEV_PARTNER_KEY });
  if (!DEV_PARTNER_KEY) {
    // `origin` is a plain instance field the client concatenates with
    // "/ws?partner=…"; pointing it at the worker yields "…/broker/ws".
    (client as unknown as { origin: string }).origin = BROKER_RELAY_ORIGIN;
  }
  return client;
}

// Hard stop for a broker trading session that never finishes.
const TRADE_TIMEOUT_MS = 180_000;

const SLIPPAGE_CHIPS = ["0.1", "0.5", "1.0"];

type QuoteResult = Awaited<ReturnType<typeof estimateSwap>>;

// ── Broker session plumbing ───────────────────────────────────────────────────
// The @stellar-broker/client d.ts references a non-exported `TransactionI`, so
// its callback types collapse to `any`; we type our side of the seam explicitly.
type Signable = { toXDR(): string; sign?: unknown };

/**
 * Authorization callback handed to the Mediator: signs classic txs with the
 * connected wallet. Only full transactions ever reach this path (the trading
 * session itself signs with the mediator's local keypair), so Soroban auth-entry
 * buffers are rejected.
 */
async function walletAuthorize(payload: Signable | Uint8Array): Promise<unknown> {
  if (payload instanceof Uint8Array || typeof payload.toXDR !== "function") {
    throw new Error("Unsupported signing payload from Stellar Broker");
  }
  const signed = await signXdr(payload.toXDR());
  // The Mediator submits the returned value straight to Horizon, so it must be
  // a Transaction object — not the signed-XDR string the wallet kit returns.
  return TransactionBuilder.fromXDR(signed, Networks.PUBLIC);
}

interface BrokerTradeResult {
  status: string;
  sold?: string;
  bought?: string;
}

/** Pull Horizon result codes out of a submit error (e.g. "tx_bad_seq, op_underfunded"). */
function horizonMessage(e: unknown): string {
  const codes = (
    e as { response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } } }
  )?.response?.data?.extras?.result_codes;
  if (codes) {
    const parts = [codes.transaction, ...(codes.operations ?? [])].filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Dispose the mediator with retries. The broker's `finished` event fires as soon
 * as the last trade tx is accepted, but Horizon can still return a stale
 * sequence/balances for the mediator for a ledger or two — a dispose fired too
 * early then 400s with tx_bad_seq / op_underfunded. `settleMs` waits ~a ledger
 * BEFORE the first attempt (the browser logs any failed POST to the console and
 * that can't be suppressed, so we avoid sending a doomed request at all);
 * `delayMs` spaces out the retries. A "doesn't exist on the ledger" error means
 * the account was already merged (a previous attempt landed), which is success.
 */
async function disposeWithRetry(mediator: Mediator, settleMs = 6000, attempts = 5, delayMs = 5000): Promise<void> {
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      await mediator.dispose();
      return;
    } catch (e) {
      if (e instanceof Error && e.message.includes("doesn't exist on the ledger")) return;
      lastErr = e;
      console.warn(`Mediator dispose attempt ${i + 1}/${attempts} failed:`, horizonMessage(e));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Run one interactive broker session: connect → quote → confirm the first
 * success quote (must be <10s old per the protocol) → wait for `finished`.
 * The mediator's secret key signs every trade tx locally, so no wallet popups.
 */
function runBrokerTrade(
  client: StellarBrokerClient,
  mediatorAddress: string,
  mediatorSecret: string,
  params: { sellingAsset: string; buyingAsset: string; sellingAmount: string; slippageTolerance: number },
): Promise<BrokerTradeResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let confirmed = false;

    const cleanup = () => {
      clearTimeout(timer);
      client.off("quote", onQuote);
      client.off("finished", onFinished);
      client.off("error", onError);
    };
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        client.stop();
      } catch {
        /* ignore */
      }
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error("Swap timed out — no result from Stellar Broker")), TRADE_TIMEOUT_MS);

    const onQuote = (e: unknown) => {
      if (settled || confirmed) return;
      const q = (e as { quote: QuoteResult }).quote;
      if (q.status !== "success") {
        fail(new Error(q.status === "unfeasible" ? "No viable route for this swap" : q.error || "Quote rejected"));
        return;
      }
      confirmed = true;
      try {
        client.confirmQuote(mediatorAddress, mediatorSecret);
      } catch (err) {
        fail(err);
      }
    };
    const onFinished = (e: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const r = (e as { result: BrokerTradeResult }).result;
      if (r.status === "success") resolve(r);
      else reject(new Error(`Swap ${r.status}${r.bought ? ` — bought ${r.bought} so far` : ""}`));
    };
    const onError = (e: unknown) => {
      fail((e as { error?: unknown }).error ?? "Stellar Broker error");
    };

    client.on("quote", onQuote);
    client.on("finished", onFinished);
    client.on("error", onError);

    client
      .connect()
      .then(() => client.quote(params))
      .catch(() => fail(new Error("Could not connect to Stellar Broker")));
  });
}

interface SwapUiState {
  sell: string; // broker id
  buy: string; // broker id
  amount: string;
  slipPct: string; // "0.1" | "0.5" | "1.0"
  quote: QuoteResult | null;
}

/** Build the Swap view. Renders immediately; quotes are fetched async on input. */
export function swapScreen(): HTMLElement {
  const root = el("div", { class: "tl-swap" });

  // The quote form renders and works whether or not a wallet is connected —
  // estimateSwap / aquariusBestRate need no address. Only the sell-side balance
  // hint and the (already quote-only) execute action gate on connect. Mirrors
  // trade.ts: public data shows; wallet-specific bits gate.

  const list = FALLBACK_SWAP_ASSETS;
  const defaultSell = "XLM";
  const defaultBuy = list.find((a) => a.symbol === "USDC")?.brokerId ?? list[1].brokerId;

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

// ── Card ──────────────────────────────────────────────────────────────────────
function renderCard(ui: SwapUiState, root: HTMLElement): HTMLElement {
  const slip = () => Number.parseFloat(ui.slipPct) / 100; // 0.5% → 0.005

  // Field refs we mutate in place (no React; imperative DOM updates).
  const receiveEl = el("div", { class: "tl-swap__receive tl-swap__receive--ph" }, ["0.0"]);
  const sellBalEl = el("span", { class: "tl-swap__bal" }, ["—"]);
  const well = el("div", { class: "tl-swap__well", style: "display:none" });
  const slipChips: HTMLButtonElement[] = [];

  let quoteTimer: ReturnType<typeof setTimeout> | null = null;
  let aqSeq = 0; // guards out-of-order Aquarius responses
  let executing = false; // a broker trading session is in flight

  // Asset registry: render with the static fallback immediately, then swap in
  // the stellar.expert top-50 list once it loads (cache-first, so usually sync).
  let assets: SwapAsset[] = FALLBACK_SWAP_ASSETS;
  const assetFor = (brokerId: string) => assets.find((a) => a.brokerId === brokerId);
  const symbolFor = (brokerId: string) => assetFor(brokerId)?.symbol ?? brokerId;

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
  const assetOptions = assets.map((a) => ({ value: a.brokerId, label: a.label }));
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

  // ── Reverse ─────────────────────────────────────────────────────────────────
  const reverseBtn = el(
    "button",
    {
      class: "tl-swap__reverse",
      type: "button",
      title: tx("swap.reverse", "Reverse pair"),
      "aria-label": tx("swap.reverse", "Reverse pair"),
    },
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

  // ── Amount input ─────────────────────────────────────────────────────────────
  on(amountInput, "input", () => {
    // Strip everything that isn't a digit or a dot (matches old-main.ts).
    const cleaned = amountInput.value.replace(/[^\d.]/g, "");
    if (cleaned !== amountInput.value) amountInput.value = cleaned;
    ui.amount = cleaned;
    ui.quote = null;
    scheduleQuote();
  });

  // ── Slippage chips ──────────────────────────────────────────────────────────
  for (const s of SLIPPAGE_CHIPS) {
    const chip = el("button", { class: `tl-swap__chip${s === ui.slipPct ? " is-active" : ""}`, type: "button" }, [
      `${s}%`,
    ]) as HTMLButtonElement;
    on(chip, "click", () => {
      ui.slipPct = s;
      slipChips.forEach((c) => c.classList.toggle("is-active", c === chip));
      updateWellSlip();
      ui.quote = null;
      scheduleQuote();
    });
    slipChips.push(chip);
  }

  // ── Quote well rows ──────────────────────────────────────────────────────────
  const rateVal = el("span", { class: "tl-swap__qrow-v" }, ["—"]);
  const dexVal = el("span", { class: "tl-swap__qrow-v" }, ["—"]);
  const advVal = el("span", { class: "tl-swap__qrow-v tl-swap__qrow-v--good" }, ["—"]);
  const slipVal = el("span", { class: "tl-swap__qrow-v" }, [`${ui.slipPct}%`]);

  well.replaceChildren(
    qrow(tx("swap.rate", "Rate"), "The effective price you get for this swap via the best routed path.", rateVal),
    qrow(
      "DEX Rate",
      "For comparison: the direct quote on the Stellar DEX (Aquarius), without broker routing.",
      dexVal,
      true,
    ),
    qrow(
      tx("swap.brokerAdvantage", "Broker advantage"),
      "How much better the broker’s routed rate is versus a direct DEX trade.",
      advVal,
    ),
    qrow(
      tx("swap.slippage", "Slippage tolerance"),
      "The maximum price movement you’ll accept before the swap fails. Lower is stricter but more likely to revert in volatile markets.",
      slipVal,
      true,
    ),
  );

  function updateWellSlip() {
    slipVal.textContent = `${ui.slipPct}%`;
  }

  // ── Dynamic asset list ────────────────────────────────────────────────────────
  function repopulateSelects() {
    const mkOptions = () => assets.map((a) => el("option", { value: a.brokerId }, [a.label]));
    sellSelect.replaceChildren(...mkOptions());
    buySelect.replaceChildren(...mkOptions());
    // Keep the current pair when it survives the refresh; else reset to defaults.
    if (!assetFor(ui.sell)) ui.sell = "XLM";
    if (!assetFor(ui.buy) || ui.buy === ui.sell) {
      ui.buy = assets.find((a) => a.symbol === "USDC")?.brokerId ?? assets[1].brokerId;
      ui.quote = null;
    }
    sellSelect.value = ui.sell;
    buySelect.value = ui.buy;
  }

  void getSwapAssets().then((list) => {
    if (list === assets) return;
    assets = list;
    repopulateSelects();
    void refreshBalance();
    updateButton();
  });

  // ── Balance ──────────────────────────────────────────────────────────────────
  async function refreshBalance() {
    const addr = getState().userAddress;
    const contractId = assetFor(ui.sell)?.contractId;
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

  // ── Button state machine (ported from updateSwapBtn) ─────────────────────────
  function updateButton() {
    if (executing) {
      setBtn(tx("swap.executing", "Swapping…"), true);
      return;
    }
    const hasAmount = !!ui.amount && Number.parseFloat(ui.amount) > 0;
    const samePair = ui.sell === ui.buy;
    // Get Quote works disconnected (estimateSwap needs no wallet). Only the
    // execute action gates on connect.
    if (samePair) {
      setBtn(tx("swap.selectDifferent", "Select a different pair"), true);
    } else if (!hasAmount) {
      setBtn(tx("swap.enterAmount", "Enter an amount"), true);
    } else if (ui.quote && ui.quote.status === "success") {
      if (!getState().userAddress) {
        setBtn(tx("nav.connect", "Connect Wallet"), true);
      } else if (!swapExecuteAvailable()) {
        setBtn(tx("swap.mainnetOnly", "Swap execution is mainnet-only"), true);
      } else {
        setBtn(tx("swap.execute", "Swap"), false);
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
      // Discard if inputs changed while the request was in flight.
      if (ui.sell !== sell || ui.buy !== buy || ui.amount !== amount) return;
      ui.quote = quote;

      if (quote.status === "success" && quote.estimatedBuyingAmount) {
        const sellNum = Number.parseFloat(amount);
        const buyNum = Number.parseFloat(quote.estimatedBuyingAmount);
        const sellSym = symbolFor(sell);
        const buySym = symbolFor(buy);

        setReceive(buyNum.toLocaleString("en-US", { maximumFractionDigits: 4 }), false);
        rateVal.textContent = `1 ${sellSym} ≈ ${(buyNum / sellNum).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${buySym}`;
        advVal.textContent =
          quote.profit && Number.parseFloat(quote.profit) > 0
            ? `+${Number.parseFloat(quote.profit).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${buySym}`
            : "—";
        showWell();
        // Cross-check against the DEX (Aquarius) and fill the DEX Rate row.
        void compareDexRate(sell, buy, sellNum, buySym);
      } else {
        ui.quote = null;
        setReceive(quote.status === "unfeasible" ? "No route" : "—", true);
        hideWell();
      }
    } catch (e) {
      // Discard stale failures too.
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
    const sellC = assetFor(sellBrokerId)?.contractId;
    const buyC = assetFor(buyBrokerId)?.contractId;
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
    // If we have no live success quote yet, the click means "Get Quote".
    if (!ui.quote || ui.quote.status !== "success") {
      if (quoteTimer) clearTimeout(quoteTimer);
      await fetchQuote();
      return;
    }
    await executeSwap();
  }

  // ── EXECUTE ───────────────────────────────────────────────────────────────────
  // Mediator flow (see @stellar-broker/client README, "Delegated Signing"):
  //  1. one wallet signature creates + funds a temporary mediator account
  //     (selling amount + ~5 XLM fee reserve, refunded at the end);
  //  2. the broker session trades autonomously, signing with the mediator's
  //     local keypair — quotes expire in 10s, so wallet-popup-per-tx is not viable;
  //  3. dispose() pays all proceeds + leftover reserves back and merges the
  //     mediator into the user's account.
  // If a previous session died before dispose, its mediator address stays in
  // localStorage; we recover those funds before starting a new swap.
  async function executeSwap() {
    const addr = getState().userAddress;
    if (!addr || !ui.quote || ui.quote.status !== "success" || executing) return;
    if (!swapExecuteAvailable()) {
      toast(tx("swap.mainnetOnly", "Swap execution is only available on mainnet."), "info");
      return;
    }

    const { sell, buy, amount } = ui;
    const steps = [
      tx("swap.stepPrepare", "Prepare"),
      tx("swap.stepTrade", "Trade"),
      tx("swap.stepFinalize", "Finalize"),
      tx("tx.confirmed", "Confirmed"),
    ];
    executing = true;
    updateButton();
    txShow(steps);

    const client = createBrokerClient();
    let mediator: Mediator | null = null;
    let funded = false;
    try {
      txStep(0);
      // Recover funds stranded in mediators from previous lost sessions first.
      // Non-fatal: dispose() throws (after cleaning localStorage) when the
      // account was already merged, and that must not block a new swap.
      if (Mediator.hasObsoleteMediators(addr)) {
        toast(tx("swap.recovering", "Recovering funds from a previous swap session…"), "info");
        try {
          await Mediator.disposeObsoleteMediators(addr, walletAuthorize as never);
        } catch (recoverErr) {
          console.warn("Obsolete mediator recovery:", horizonMessage(recoverErr));
        }
      }
      mediator = new Mediator(addr, sell, buy, amount, walletAuthorize as never);
      // Wallet signature + Horizon submit: create/fund the mediator account.
      const mediatorSecret = await mediator.init();
      funded = true;

      txStep(1);
      const result = await runBrokerTrade(client, mediator.mediatorAddress, mediatorSecret, {
        sellingAsset: sell,
        buyingAsset: buy,
        sellingAmount: amount,
        slippageTolerance: slip(),
      });

      txStep(2);
      // Send proceeds + unused XLM reserve back and merge the mediator account.
      // The trade itself already succeeded, so a dispose failure must not surface
      // as a swap error: funds sit safely on the mediator and the localStorage
      // record guarantees recovery on the next swap.
      funded = false;
      let disposed = false;
      try {
        await disposeWithRetry(mediator);
        disposed = true;
      } catch (disposeErr) {
        console.warn("Mediator dispose failed — will recover on next swap", horizonMessage(disposeErr));
      }

      txStep(steps.length);
      const sold = result.sold ?? amount;
      const bought = result.bought ?? "?";
      toast(`${tx("swap.done", "Swap complete")}: ${sold} ${symbolFor(sell)} → ${bought} ${symbolFor(buy)}`, "success");
      if (!disposed) {
        toast(
          tx(
            "swap.recoverLater",
            "Returning the funds timed out — they're held in a temporary account and will be recovered automatically on your next swap.",
          ),
          "info",
        );
      }
      txHide();
      ui.quote = null;
      void refreshBalance();
    } catch (e) {
      // Best-effort refund if the trade failed after the mediator was funded.
      // If dispose fails too, the localStorage record keeps the mediator
      // recoverable on the next swap attempt.
      if (funded && mediator) {
        try {
          await disposeWithRetry(mediator);
        } catch (disposeErr) {
          console.warn("Mediator dispose failed — will recover on next swap", horizonMessage(disposeErr));
        }
      }
      txStep(steps.length - 1, true);
      toast(horizonMessage(e), "error");
      txHide();
    } finally {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      executing = false;
      updateButton();
    }
  }

  // ── Layout ────────────────────────────────────────────────────────────────────
  const card = el("div", { class: "tl-swap__card" }, [
    // Header
    el("div", { class: "tl-swap__head" }, [
      el("h2", { class: "tl-swap__title" }, [tx("swap.title", "Swap")]),
      el("span", { class: "tl-swap__via" }, [
        tx("swap.via", "via Stellar Broker"),
        Tooltip({
          text: "Swaps route through Stellar Broker, which aggregates the best path across Stellar DEXes (including Aquarius) for the best execution.",
        }),
      ]),
    ]),

    // You sell
    el("div", { class: "tl-swap__label-row" }, [
      el("label", { class: "tl-swap__label" }, [tx("swap.youSell", "You sell")]),
      sellBalEl,
    ]),
    el("div", { class: "tl-swap__row" }, [amountField, sellSelect]),

    // Reverse
    el("div", { class: "tl-swap__reverse-wrap" }, [reverseBtn]),

    // You receive
    el("label", { class: "tl-swap__label" }, [tx("swap.youReceive", "You receive (estimated)")]),
    el("div", { class: "tl-swap__row" }, [receiveEl, buySelect]),

    // Quote well
    well,

    // Slippage chips
    el("div", { class: "tl-swap__slip" }, [
      el("span", { class: "tl-swap__slip-label" }, [tx("swap.slippageShort", "Slippage")]),
      ...slipChips,
    ]),

    // Primary action
    actionBtn,

    // Footnote
    el("p", { class: "tl-swap__foot" }, [
      "Swaps are executed through ",
      el("strong", {}, ["Stellar Broker"]),
      " for best-route aggregation across Stellar DEXes.",
    ]),
  ]);

  // Initial async fills.
  void refreshBalance();
  updateButton();

  return el("div", { class: "tl-swap__wrap" }, [card]);
}

// ── Quote-well row ──────────────────────────────────────────────────────────────
function qrow(label: string, tip: string, valueEl: HTMLElement, dim = false): HTMLElement {
  return el("div", { class: `tl-swap__qrow${dim ? " tl-swap__qrow--dim" : ""}` }, [
    el("span", { class: "tl-swap__qrow-k" }, [label, Tooltip({ text: tip })]),
    valueEl,
  ]);
}
