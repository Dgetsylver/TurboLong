import "./vault.css";
/**
 * Vault screen — passive leveraged DeFindex vaults on the V3 design system.
 *
 * View-only rewrite: the data/service layer (defindex.ts, blend.ts,
 * aquarius_listings.ts) is reused unchanged. The wiring (getActiveVault /
 * refreshVaultView / renderAquariusTradeCard + deposit/withdraw/rebalance
 * handlers) is ported from the original main.ts — only the rendering is new.
 *
 * Pattern mirrors dashboard.screen.ts: render a lightweight skeleton/empty
 * state immediately, then fill async per selected vault.
 */
import {
  el,
  on,
  Card,
  Badge,
  Button,
  Input,
  MetricHero,
  StatCard,
  HealthFactor,
  Tooltip,
  Skeleton,
} from "../ui";
import {
  getVaults,
  fetchVaultStats,
  fetchUserVaultBalance,
  fetchTokenBalance,
  buildVaultDepositXdr,
  buildVaultWithdrawXdr,
  buildVaultRebalanceXdr,
  formatUsd,
  formatHf,
  type VaultConfig,
  type VaultStats,
} from "../defindex";
import { fetchAllReserves, getKnownPools, getActiveNetwork, type ReserveStats } from "../blend";
import { getAquariusListing, AQUARIUS_SWAP_URL } from "../aquarius_listings";
import { getState } from "../app/state";
import { signAndSubmit } from "../app/wallet";
import { toast, txShow, txStep, txHide } from "../app/chrome";
import { t } from "../i18n";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** APR (percent) → compounded APY (percent). Mirrors old-main's aprToApy. */
const aprToApy = (apr: number) => (Math.exp(apr / 100) - 1) * 100;

/** Translate, but fall back to the literal when the key round-trips unchanged. */
const tt = (key: string, fallback: string) => {
  const v = t(key);
  return v === key ? fallback : v;
};

function expertContractUrl(id: string): string {
  const net = getActiveNetwork() === "testnet" ? "testnet" : "public";
  return `https://stellar.expert/explorer/${net}/contract/${id}`;
}

/** Compose a label + inline "?" tooltip (matches the React `lbl` helper). */
function lbl(text: string, tip: string): HTMLElement {
  return el("span", { class: "vault-lbl" }, [text, Tooltip({ text: tip })]);
}

// Per-screen state, mirroring the original module-level caches.
interface VaultViewState {
  selectedId: string;
  lastStats: VaultStats | null;
  userWalletBalance: number;
  userVaultBalance: number;
}

// ── Detail rendering ───────────────────────────────────────────────────────

/** Build the receipt-token / "Trade on Aquarius" block for a vault. */
function aquariusBlock(vault: VaultConfig): HTMLElement {
  const listing = getAquariusListing(vault.assetSymbol);
  const headRow = el("div", { class: "vault-receipt__row" }, [
    el("span", { class: "vault-receipt__label" }, [
      tt("vault.receiptToken", "Receipt token"),
      Tooltip({
        text:
          "A transferable SEP-41 token representing your vault deposit. Trade it against the asset on Aquarius to exit without unwinding the loop on-chain.",
      }),
    ]),
  ]);

  if (listing?.shareToken) {
    const id = listing.shareToken;
    const short = `${id.slice(0, 6)}…${id.slice(-4)}`;
    const copyBtn = Button({
      variant: "ghost",
      size: "sm",
      title: "Copy contract ID",
      children: "Copy",
    });
    on(copyBtn, "click", () => {
      void navigator.clipboard?.writeText(id).then(
        () => toast("Contract ID copied", "success"),
        () => toast("Copy failed", "error"),
      );
    });
    headRow.append(
      el("span", { class: "vault-receipt__id" }, [
        el("code", { class: "vault-mono vault-receipt__code", title: id }, [short]),
        copyBtn,
        el(
          "a",
          {
            class: "vault-receipt__explorer",
            href: expertContractUrl(id),
            target: "_blank",
            rel: "noopener",
          },
          ["Explorer ↗"],
        ),
      ]),
    );
  } else {
    headRow.append(el("span", { class: "vault-receipt__id vault-mono vault-receipt__pending" }, [`tl${vault.assetSymbol}`]));
  }

  const tradeBtn = Button({
    variant: "secondary",
    fullWidth: true,
    children: `${tt("vault.tradeCta", "Trade on Aquarius")} ↗`,
  });
  on(tradeBtn, "click", () => window.open(AQUARIUS_SWAP_URL, "_blank", "noopener"));

  const note = listing?.shareToken
    ? tt(
        "vault.tradeOnAquariusSub",
        `Your vault deposit is a transferable SEP-41 receipt token. It trades against ${vault.assetSymbol} on Aquarius, so you can exit without unwinding the loop on-chain.`,
      )
    : tt(
        "vault.listingPending",
        "Listing on Aquarius after the mainnet vault launch. The receipt token will trade against USDC, so you can exit your leveraged position without unwinding the loop on-chain.",
      );

  return el("div", { class: "vault-receipt" }, [headRow, tradeBtn, el("p", { class: "vault-note" }, [note])]);
}

/** Header (title + Strategy/Auto-rebalance badges) + 3 MetricHero. */
function detailHeader(vault: VaultConfig, stats: VaultStats | null): HTMLElement {
  const ready = !!vault.vaultId;

  const tvl = ready && stats ? formatUsd(stats.totalEquity) : ready ? "—" : tt("common.notDeployed", "Not deployed");
  const sharePrice = ready && stats ? formatUsd(stats.sharePrice, 6) : "—";

  let apyText = "—";
  let apyTone: "default" | "success" | "danger" = "default";
  if (ready && stats && stats.netApy !== null) {
    const baseApy = aprToApy(stats.netApy);
    const harvestApy = stats.harvestApy ? stats.harvestApy * 100 : 0;
    const totalApy = baseApy + harvestApy;
    apyText = (totalApy >= 0 ? "+" : "") + totalApy.toFixed(2) + "%";
    apyTone = totalApy >= 0 ? "success" : "danger";
  }

  const head = el("div", { class: "vault-detail__head" }, [
    el("h2", { class: "vault-detail__title" }, [vault.name]),
    Badge({ tone: "blnd", children: tt("vault.strategyBadge", "Strategy") }),
    Tooltip({
      text:
        "A managed, automated leverage loop you deposit into passively — Turbolong runs the supply/borrow loop for you.",
    }),
    Badge({ tone: "success", dot: true, children: "Auto-rebalance" }),
    Tooltip({
      text:
        "A permissionless keeper partially unwinds the loop when the Health Factor drops below the minimum, protecting all depositors.",
    }),
  ]);

  const heroes = el("div", { class: "vault-heroes" }, [
    MetricHero({
      label: lbl(tt("vault.totalTvl", "Total TVL"), "Total Value Locked — the sum of all deposits in this vault."),
      value: tvl,
    }),
    MetricHero({
      label: lbl(
        tt("vault.sharePrice", "Share Price"),
        "Value of one vault share in the underlying asset. It rises as the strategy earns.",
      ),
      value: sharePrice,
      sub: `${vault.assetSymbol} per share`,
    }),
    MetricHero({
      label: lbl(
        tt("vault.netApy", "Net APY"),
        "The vault’s net annualized yield after borrow costs, from the leveraged loop. Shown as APY (compounded).",
      ),
      value: apyText,
      tone: apyTone,
    }),
  ]);

  return el("div", {}, [head, heroes]);
}

/** Strategy Position card: 4 StatCards + strategy HealthFactor + keeper note. */
function strategyCard(vault: VaultConfig, stats: VaultStats | null): HTMLElement {
  const ready = !!vault.vaultId;
  const sym = vault.assetSymbol;

  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const collateral = ready && stats ? `${fmt(stats.collateralValue)} ${sym}` : "—";
  const debt = ready && stats ? `${fmt(stats.debtValue)} ${sym}` : "—";
  const equity = ready && stats ? `${fmt(stats.totalEquity)} ${sym}` : "—";
  const loops = ready ? `${vault.targetLoops}×` : "—";

  const stats4 = el("div", { class: "vault-stats4" }, [
    StatCard({
      label: lbl(tt("vault.collateral", "Collateral"), "Total assets the strategy has supplied as collateral across the loop."),
      value: collateral,
    }),
    StatCard({
      label: lbl(tt("vault.debt", "Debt"), "Total the strategy has borrowed against its collateral."),
      value: debt,
      tone: "danger",
    }),
    StatCard({
      label: lbl(
        tt("vault.netEquity", "Net Equity"),
        "Collateral minus debt — the strategy’s own capital, which depositors own a share of.",
      ),
      value: equity,
      tone: "success",
    }),
    StatCard({
      label: lbl(tt("vault.loops", "Loops"), "How many times collateral was re-supplied and borrowed to build the leverage."),
      value: loops,
    }),
  ]);

  const hfValue = ready && stats && Number.isFinite(stats.healthFactor) ? stats.healthFactor : ready && stats ? 2.5 : 0;
  const hfWell = el("div", { class: "vault-hf-well" }, [
    HealthFactor({ value: hfValue, maxScale: 2.5, labelTitle: tt("vault.hfTip", "Strategy health factor.") }),
  ]);

  const keeperNote = el("div", { class: "vault-keeper" }, [
    Badge({ tone: "success", children: "Keeper" }),
    el("span", {}, [
      tt(
        "vault.keeperNote",
        "Auto-rebalance keeper monitors the health factor and partially unwinds the loop when HF drops below the minimum",
      ),
      " (",
      el("span", { class: "vault-mono" }, [vault.minHf.toFixed(2)]),
      "), protecting all depositors. Rebalance is permissionless.",
    ]),
  ]);

  return Card({ title: tt("vault.strategyPosition", "Strategy Position"), children: [stats4, hfWell, keeperNote] });
}

// ── Your Position card (deposit / withdraw / rebalance) ──────────────────────

interface DetailHandlers {
  refresh: () => void;
}

function yourPositionCard(
  vault: VaultConfig,
  stats: VaultStats | null,
  vs: VaultViewState,
  h: DetailHandlers,
): HTMLElement {
  const addr = getState().userAddress;
  const ready = !!vault.vaultId;
  const sym = vault.assetSymbol;

  // Read-out rows.
  const userEquity = vs.userVaultBalance > 0 ? formatUsd(vs.userVaultBalance) : "—";
  const sharePct =
    vs.userVaultBalance > 0 && stats && stats.totalEquity > 0
      ? `${((vs.userVaultBalance / stats.totalEquity) * 100).toFixed(2)}%`
      : "—";

  const row = (label: HTMLElement | string, value: string, strong = false) =>
    el("div", { class: "vault-row" }, [
      typeof label === "string" ? el("span", { class: "vault-row__label" }, [label]) : label,
      el("span", { class: "vault-mono vault-row__value" + (strong ? " vault-row__value--strong" : "") }, [value]),
    ]);

  const equityRow = row(tt("vault.yourEquity", "Your Equity"), userEquity, true);
  const shareRow = row(
    lbl(tt("vault.shareOfVault", "Share of Vault"), "Your portion of the vault’s net equity, based on the shares you hold."),
    sharePct,
  );

  // ── Deposit ──
  const depInput = Input({
    placeholder: "0.00",
    inputMode: "decimal",
    suffix: sym,
    disabled: !addr || !ready,
    onMax: () => {
      if (vs.userWalletBalance > 0) depField.value = vs.userWalletBalance.toFixed(2);
    },
  });
  const depField = depInput.querySelector("input") as HTMLInputElement;

  const depBtn = Button({
    variant: "primary",
    size: "lg",
    fullWidth: true,
    disabled: !addr || !ready,
    children: `${tt("vault.deposit", "Deposit")} ${sym}`,
  });
  on(depBtn, "click", () => void runDeposit());

  // ── Withdraw ──
  const wdInput = Input({
    placeholder: "0.00",
    inputMode: "decimal",
    suffix: sym,
    disabled: !addr || !ready,
    onMax: () => {
      if (vs.userVaultBalance > 0) {
        // Tiny buffer to avoid InsufficientBalance from rounding (matches old-main).
        const safe = Math.max(vs.userVaultBalance - 0.001, 0);
        wdField.value = safe > 0 ? safe.toFixed(4) : "";
      }
    },
  });
  const wdField = wdInput.querySelector("input") as HTMLInputElement;

  const wdBtn = Button({
    variant: "ghost",
    fullWidth: true,
    disabled: !addr || !ready,
    children: tt("vault.withdraw", "Withdraw"),
  });
  on(wdBtn, "click", () => void runWithdraw());

  const walletHint = el("p", { class: "vault-wallet-hint" }, [
    addr ? `Wallet: ${vs.userWalletBalance.toFixed(2)} ${sym}` : "Connect a wallet to deposit.",
  ]);

  async function runDeposit() {
    if (!addr || !vault.vaultId) return;
    const amount = Number.parseFloat(depField.value);
    if (!amount || amount <= 0) {
      toast("Enter a deposit amount", "error");
      return;
    }
    depBtn.disabled = true;
    txShow(["Build", `Sign deposit`, "Submit", "Confirmed"]);
    try {
      txStep(0);
      const xdr = await buildVaultDepositXdr(vault, addr, amount);
      txStep(1);
      const hash = await signAndSubmit(xdr, `Deposit ${amount} ${sym}`);
      txStep(3);
      txHide();
      toast(`Deposited ${amount} ${sym}`, "success", hash);
      depField.value = "";
      h.refresh();
    } catch (err) {
      txStep(1, true);
      txHide();
      toast(`Deposit failed: ${(err as Error)?.message ?? err}`, "error");
    } finally {
      depBtn.disabled = !addr || !ready;
    }
  }

  async function runWithdraw() {
    if (!addr || !vault.vaultId) return;
    let amount = Number.parseFloat(wdField.value);
    if (!amount || amount <= 0) {
      toast("Enter a withdraw amount", "error");
      return;
    }
    // Cap at vault balance to avoid InsufficientBalance from rounding (matches old-main).
    if (vs.userVaultBalance > 0 && amount >= vs.userVaultBalance) {
      amount = Math.max(vs.userVaultBalance - 0.001, 0.001);
    }
    wdBtn.disabled = true;
    txShow(["Build", "Sign withdraw", "Submit", "Confirmed"]);
    try {
      txStep(0);
      const xdr = await buildVaultWithdrawXdr(vault, addr, amount);
      txStep(1);
      const hash = await signAndSubmit(xdr, `Withdraw ${amount} ${sym}`);
      txStep(3);
      txHide();
      toast(`Withdrawn ${amount} ${sym}`, "success", hash);
      wdField.value = "";
      h.refresh();
    } catch (err) {
      txStep(1, true);
      txHide();
      toast(`Withdraw failed: ${(err as Error)?.message ?? err}`, "error");
    } finally {
      wdBtn.disabled = !addr || !ready;
    }
  }

  // ── Rebalance (permissionless; enabled only when HF < min) ──
  const needsRebalance =
    ready && stats && Number.isFinite(stats.healthFactor) && stats.healthFactor < vault.minHf;
  const rebalBtn = Button({
    variant: "danger",
    fullWidth: true,
    disabled: !addr || !needsRebalance,
    children: tt("vault.rebalance", "Rebalance"),
  });
  on(rebalBtn, "click", () => void runRebalance());
  const rebalHint = el(
    "p",
    { class: "vault-rebal-hint " + (needsRebalance ? "vault-rebal-hint--bad" : "vault-rebal-hint--ok") },
    [needsRebalance ? tt("vault.hfBelowMin", "HF below minimum — rebalance available") : tt("vault.hfHealthy", "HF is healthy")],
  );

  async function runRebalance() {
    if (!addr || !vault.vaultId) return;
    rebalBtn.disabled = true;
    txShow(["Build", "Sign rebalance", "Submit", "Confirmed"]);
    try {
      txStep(0);
      const xdr = await buildVaultRebalanceXdr(vault, addr);
      txStep(1);
      const hash = await signAndSubmit(xdr, "Rebalance vault");
      txStep(3);
      txHide();
      toast("Vault rebalanced", "success", hash);
      h.refresh();
    } catch (err) {
      txStep(1, true);
      txHide();
      toast(`Rebalance failed: ${(err as Error)?.message ?? err}`, "error");
    } finally {
      rebalBtn.disabled = !addr || !needsRebalance;
    }
  }

  const children: (HTMLElement | string)[] = [
    equityRow,
    shareRow,
    el("div", { class: "vault-field" }, [el("label", { class: "vault-field__label" }, [`Deposit ${sym}`]), depInput]),
    depBtn,
    el("div", { class: "vault-field" }, [el("label", { class: "vault-field__label" }, [`Withdraw ${sym}`]), wdInput]),
    wdBtn,
    walletHint,
    el("div", { class: "vault-divider" }, [aquariusBlock(vault)]),
    el("div", { class: "vault-rebal" }, [rebalBtn, rebalHint]),
  ];

  return Card({ title: tt("vault.yourPosition", "Your Position"), class: "vault-your", children });
}

// ── Vault selector tiles ─────────────────────────────────────────────────────

function selectorTile(
  vault: VaultConfig,
  active: boolean,
  apyText: string,
  tvlText: string,
  soon: boolean,
  onSelect: () => void,
): HTMLElement {
  const tile = el("button", { class: "vault-tile" + (active ? " vault-tile--active" : "") + (soon ? " vault-tile--soon" : "") }, [
    el("div", { class: "vault-tile__top" }, [
      el("span", { class: "vault-mono vault-tile__asset" }, [vault.assetSymbol]),
      el("span", { class: "vault-tile__pool" }, [vault.name.replace(/^Leveraged\s+\S+\s*/, "").replace(/[()]/g, "").trim() || "Strategy"]),
      soon ? Badge({ tone: "neutral", children: "Soon" }) : null,
    ]),
    el("div", { class: "vault-tile__bottom" }, [
      el("span", { class: "vault-mono vault-tile__apy" + (soon ? " vault-tile__apy--soon" : "") }, [apyText]),
      el("span", { class: "vault-tile__tvl" }, [`TVL ${tvlText}`]),
    ]),
  ]);
  if (soon) {
    tile.setAttribute("disabled", "true");
  } else {
    on(tile, "click", onSelect);
  }
  return tile;
}

// ── Screen ───────────────────────────────────────────────────────────────────

/** Build the Vault view. Renders immediately; fills with live data async. */
export function vaultScreen(): HTMLElement {
  const root = el("div", { class: "vault" });
  const addr = getState().userAddress;

  // Intro header (always shown).
  const intro = el("div", { class: "vault__intro" }, [
    el("h1", { class: "vault__title" }, [tt("vault.title", "Vault")]),
    el("p", { class: "vault__sub" }, [
      tt(
        "vault.sub",
        "Deposit into a managed leveraged vault and receive a transferable SEP-41 receipt token you can later trade on Aquarius.",
      ),
    ]),
  ]);
  root.append(intro);

  const vaults = getVaults();
  if (!vaults.length) {
    root.append(Card({ children: el("p", { class: "vault-empty" }, ["No vaults available on this network."]) }));
    return root;
  }

  // Disconnected → connect empty state (no actions).
  if (!addr) {
    root.append(
      Card({
        class: "vault-connect",
        children: el("div", { class: "vault-connect__inner" }, [
          el("p", { class: "vault-connect__msg" }, ["Connect your wallet to deposit into a leveraged vault."]),
          el("p", { class: "vault-connect__sub" }, [
            "Vaults run an automated, keeper-protected leverage loop. You receive a transferable SEP-41 receipt token.",
          ]),
        ]),
      }),
    );
    return root;
  }

  // Per-screen mutable state. Prefer a deployed vault as the default selection.
  const vs: VaultViewState = {
    selectedId: (vaults.find((v) => v.vaultId) ?? vaults[0]).vaultId || vaults[0].assetId,
    lastStats: null,
    userWalletBalance: 0,
    userVaultBalance: 0,
  };
  const vaultKey = (v: VaultConfig) => v.vaultId || v.assetId;

  const selectorEl = el("div", { class: "vault-selector" });
  const detailEl = el("div", { class: "vault-detail" });
  root.append(selectorEl, detailEl);

  const cache = new Map<string, VaultStats | null>();

  function selectedVault(): VaultConfig {
    return vaults.find((v) => vaultKey(v) === vs.selectedId) ?? vaults[0];
  }

  function renderSelector() {
    const tiles = vaults.map((v) => {
      const soon = !v.vaultId;
      const stats = cache.get(vaultKey(v));
      let apyText = soon ? "—" : "…";
      if (stats && stats.netApy !== null) {
        const totalApy = aprToApy(stats.netApy) + (stats.harvestApy ? stats.harvestApy * 100 : 0);
        apyText = (totalApy >= 0 ? "+" : "") + totalApy.toFixed(1) + "%";
      } else if (soon) {
        apyText = "—";
      }
      const tvlText = soon ? "—" : stats ? formatUsd(stats.totalEquity) : "…";
      return selectorTile(v, vaultKey(v) === vs.selectedId, apyText, tvlText, soon, () => {
        vs.selectedId = vaultKey(v);
        vs.userVaultBalance = 0;
        vs.userWalletBalance = 0;
        renderSelector();
        loadDetail();
      });
    });
    selectorEl.replaceChildren(...tiles);
  }

  function renderDetail(loading: boolean) {
    const vault = selectedVault();
    const stats = cache.get(vaultKey(vault)) ?? null;
    vs.lastStats = stats;

    const left = loading
      ? Card({ title: tt("vault.strategyPosition", "Strategy Position"), children: skeletonBlock() })
      : strategyCard(vault, stats);
    const right = yourPositionCard(vault, stats, vs, { refresh: () => loadDetail() });

    detailEl.replaceChildren(
      detailHeader(vault, stats),
      el("div", { class: "vault-cols" }, [left, right]),
    );
  }

  function skeletonBlock(): HTMLElement {
    return el("div", { class: "vault-skel" }, [
      Skeleton({ height: "64px" }),
      Skeleton({ height: "64px" }),
      Skeleton({ height: "80px" }),
    ]);
  }

  async function loadDetail() {
    const vault = selectedVault();
    renderDetail(!cache.has(vaultKey(vault)));

    if (!vault.vaultId) {
      cache.set(vaultKey(vault), null);
      renderDetail(false);
      return;
    }

    // Pool reserves for the leveraged-APY calc (best-effort).
    let poolReserves: ReserveStats[] | undefined;
    try {
      const pool = getKnownPools().find((p) => p.id === vault.poolId);
      if (pool) {
        poolReserves = await fetchAllReserves(
          pool,
          addr ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
      }
    } catch {
      /* APY degrades to "—" */
    }

    try {
      const stats = await fetchVaultStats(vault, poolReserves);
      cache.set(vaultKey(vault), stats);
    } catch (e) {
      console.warn(`Vault: stats load failed for ${vault.name}`, e);
      cache.set(vaultKey(vault), null);
    }

    // User balances (wallet token + vault equity).
    if (addr) {
      try {
        vs.userWalletBalance = await fetchTokenBalance(vault.assetId, addr, vault.decimals);
      } catch {
        vs.userWalletBalance = 0;
      }
      try {
        const pos = await fetchUserVaultBalance(vault, addr);
        vs.userVaultBalance = pos && pos.underlyingValue > 0 ? pos.underlyingValue : 0;
      } catch {
        vs.userVaultBalance = 0;
      }
    }

    // Re-render selector (APY/TVL now known) + detail with live data.
    renderSelector();
    renderDetail(false);
  }

  // Initial paint + async fill.
  renderSelector();
  loadDetail();

  return root;
}
