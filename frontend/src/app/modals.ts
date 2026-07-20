/** App modals: first-visit disclaimer gate, keyboard shortcuts, alerts, tour. */
import { el, on, Modal, Button, Input, Select } from "../ui";
import { toast } from "./chrome";
import { startTour } from "../tour";
import { getKnownPools, getPoolAssets } from "../blend";
import { ALERTS_WORKER_URL } from "../history";
import { getState } from "./state";

function mountModal(node: HTMLElement | null): () => void {
  if (!node) return () => {};
  document.body.appendChild(node);
  return () => node.remove();
}

/** First-visit risk disclaimer — must acknowledge to enter. Resolves once accepted. */
export function showDisclaimerIfNeeded(): Promise<void> {
  return new Promise((resolve) => {
    if (localStorage.getItem("disclaimerAccepted")) {
      resolve();
      return;
    }
    const check = el("input", { type: "checkbox", id: "tl-disc-check" }) as HTMLInputElement;
    const enter = Button({ children: "Enter app", disabled: true, fullWidth: true });
    on(check, "change", () => {
      (enter as HTMLButtonElement).disabled = !check.checked;
    });
    let close = () => {};
    on(enter, "click", () => {
      if (!check.checked) return;
      localStorage.setItem("disclaimerAccepted", "1");
      close();
      resolve();
    });
    const body = el("div", { style: "display:flex;flex-direction:column;gap:var(--tl-space-5)" }, [
      el(
        "p",
        { style: "margin:0;color:var(--tl-text-2);font-size:var(--tl-text-base);line-height:var(--tl-leading-body)" },
        [
          "Turbolong opens leveraged positions on Blend lending pools. Leverage amplifies both yield and risk — if your collateral value falls enough, your position is liquidated and you may lose your entire deposit. BLND emissions are variable and not guaranteed.",
        ],
      ),
      el(
        "label",
        {
          style:
            "display:flex;gap:var(--tl-space-3);align-items:center;font-size:var(--tl-text-base);color:var(--tl-text);cursor:pointer",
        },
        [check, el("span", {}, ["I understand the risks, including liquidation and total loss."])],
      ),
    ]);
    const node = Modal({
      open: true,
      title: "Before you start",
      icon: "⚠",
      width: 460,
      closeOnBackdrop: false,
      children: body,
      footer: enter,
    });
    close = mountModal(node);
  });
}

export function openShortcuts(): void {
  const rows: [string, string][] = [
    ["L", "Focus the leverage slider"],
    ["C", "Close the open position"],
    ["R", "Refresh data"],
    ["Esc", "Dismiss dialogs"],
    ["?", "Toggle this help"],
  ];
  let close = () => {};
  const body = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:var(--tl-space-3)" },
    rows.map(([k, label]) =>
      el(
        "div",
        { style: "display:flex;justify-content:space-between;gap:var(--tl-space-7);font-size:var(--tl-text-base)" },
        [
          el(
            "kbd",
            {
              style:
                "font-family:var(--tl-font-mono);background:var(--tl-surface-2);border:1px solid var(--tl-border);border-radius:var(--tl-radius-xs);padding:1px var(--tl-space-2);color:var(--tl-text)",
            },
            [k],
          ),
          el("span", { style: "color:var(--tl-text-2)" }, [label]),
        ],
      ),
    ),
  );
  const node = Modal({ open: true, title: "Keyboard shortcuts", width: 360, onClose: () => close(), children: body });
  close = mountModal(node);
}

// Leverage brackets accepted by the alerts service (POST /subscribe).
const ALERT_LEVERAGE_BRACKETS = [2, 3, 5, 8, 10];

const ALERT_TYPES = [
  { value: "apy", label: "Net APY turns negative" },
  { value: "hf", label: "Health factor below threshold…" },
  { value: "liquidation", label: "Liquidation imminent (HF < 1.05)" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function openAlerts(): void {
  let close = () => {};

  // The alerts service watches mainnet pools only — a testnet pool_id would be
  // rejected with "Unknown pool".
  if (getState().network !== "mainnet") {
    toast("Alerts are only available on mainnet — switch networks to subscribe.", "error");
    return;
  }

  const pools = getKnownPools();
  let poolId = pools[0]?.id ?? "";
  let assetSymbol = "";
  let leverage = "10";
  let alertType = "apy";
  let emailVal = "";
  let hfThresholdVal = "1.10";

  const fieldLabel = (text: string) =>
    el("span", { style: "font-size:var(--tl-text-sm);color:var(--tl-text-2)" }, [text]);
  const fieldCol = (label: string, control: HTMLElement) =>
    el("label", { style: "display:flex;flex-direction:column;gap:var(--tl-space-2);flex:1" }, [
      fieldLabel(label),
      control,
    ]);

  const email = Input({
    placeholder: "you@email.com",
    type: "email",
    inputMode: "email",
    onChange: (v) => {
      emailVal = v.trim();
    },
  });

  const assetSelect = Select({
    options: [],
    onChange: (v) => {
      assetSymbol = v;
    },
  });
  const fillAssets = () => {
    const pool = pools.find((p) => p.id === poolId);
    const symbols = pool ? getPoolAssets(pool).map((a) => a.symbol) : [];
    assetSelect.replaceChildren(...symbols.map((s) => el("option", { value: s }, [s])));
    assetSymbol = symbols[0] ?? "";
    if (assetSymbol) assetSelect.value = assetSymbol;
  };

  const poolSelect = Select({
    options: pools.map((p) => ({ value: p.id, label: p.name })),
    value: poolId,
    onChange: (v) => {
      poolId = v;
      fillAssets();
    },
  });
  fillAssets();

  const levSelect = Select({
    options: ALERT_LEVERAGE_BRACKETS.map((l) => ({ value: String(l), label: `${l}×` })),
    value: leverage,
    onChange: (v) => {
      leverage = v;
    },
  });

  const hfInput = Input({
    value: hfThresholdVal,
    inputMode: "decimal",
    onChange: (v) => {
      hfThresholdVal = v.trim();
    },
  });
  const hfRow = fieldCol("HF threshold (> 1)", hfInput);
  hfRow.style.display = "none";

  const typeSelect = Select({
    options: ALERT_TYPES,
    value: alertType,
    mono: false,
    onChange: (v) => {
      alertType = v;
      hfRow.style.display = v === "hf" ? "" : "none";
    },
  });

  const submit = Button({ children: "Subscribe", fullWidth: true }) as HTMLButtonElement;
  on(submit, "click", () => void doSubscribe());

  async function doSubscribe(): Promise<void> {
    if (!EMAIL_RE.test(emailVal)) {
      toast("Enter a valid email address.", "error");
      return;
    }
    const hfThreshold = Number(hfThresholdVal);
    if (alertType === "hf" && (!Number.isFinite(hfThreshold) || hfThreshold <= 1)) {
      toast("HF threshold must be a number greater than 1.", "error");
      return;
    }
    submit.disabled = true;
    submit.textContent = "Subscribing…";
    try {
      const res = await fetch(`${ALERTS_WORKER_URL}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: emailVal,
          pool_id: poolId,
          asset_symbol: assetSymbol,
          leverage_bracket: Number(leverage),
          alert_type: alertType,
          ...(alertType === "hf" ? { hf_threshold: hfThreshold } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (res.ok && d.ok) {
        close();
        toast(d.message ?? "Check your email to verify your alert subscription.", "success");
      } else {
        toast(d.error ?? `Subscription failed (${res.status}).`, "error");
      }
    } catch {
      toast("Alerts service unreachable — try again later.", "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "Subscribe";
    }
  }

  const body = el("div", { style: "display:flex;flex-direction:column;gap:var(--tl-space-5)" }, [
    el("p", { style: "margin:0;color:var(--tl-text-2);font-size:var(--tl-text-base)" }, [
      "Get an email when your position needs attention. Pick the pool, asset and leverage to watch — you'll receive a verification email first.",
    ]),
    fieldCol("Email", email),
    el("div", { style: "display:flex;gap:var(--tl-space-4)" }, [
      fieldCol("Pool", poolSelect),
      fieldCol("Asset", assetSelect),
      fieldCol("Leverage", levSelect),
    ]),
    fieldCol("Alert me when", typeSelect),
    hfRow,
    submit,
  ]);
  const node = Modal({ open: true, title: "Set up alerts", width: 440, onClose: () => close(), children: body });
  close = mountModal(node);
}

export function openAppModal(name: "alerts" | "shortcuts" | "tour"): void {
  if (name === "shortcuts") openShortcuts();
  else if (name === "alerts") openAlerts();
  else if (name === "tour") startTour();
}
