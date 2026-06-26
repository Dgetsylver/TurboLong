/** App modals: first-visit disclaimer gate, keyboard shortcuts, alerts, tour. */
import { el, on, Modal, Button, Input } from "../ui";
import { toast } from "./chrome";
import { startTour } from "../tour";

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
      el("p", { style: "margin:0;color:var(--tl-text-2);font-size:var(--tl-text-base);line-height:var(--tl-leading-body)" }, [
        "Turbolong opens leveraged positions on Blend lending pools. Leverage amplifies both yield and risk — if your collateral value falls enough, your position is liquidated and you may lose your entire deposit. BLND emissions are variable and not guaranteed.",
      ]),
      el("label", { style: "display:flex;gap:var(--tl-space-3);align-items:center;font-size:var(--tl-text-base);color:var(--tl-text);cursor:pointer" }, [
        check,
        el("span", {}, ["I understand the risks, including liquidation and total loss."]),
      ]),
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
  const body = el("div", { style: "display:flex;flex-direction:column;gap:var(--tl-space-3)" },
    rows.map(([k, label]) =>
      el("div", { style: "display:flex;justify-content:space-between;gap:var(--tl-space-7);font-size:var(--tl-text-base)" }, [
        el("kbd", { style: "font-family:var(--tl-font-mono);background:var(--tl-surface-2);border:1px solid var(--tl-border);border-radius:var(--tl-radius-xs);padding:1px var(--tl-space-2);color:var(--tl-text)" }, [k]),
        el("span", { style: "color:var(--tl-text-2)" }, [label]),
      ]),
    ),
  );
  const node = Modal({ open: true, title: "Keyboard shortcuts", width: 360, onClose: () => close(), children: body });
  close = mountModal(node);
}

export function openAlerts(): void {
  let close = () => {};
  const email = Input({ placeholder: "you@email.com", type: "text" });
  const submit = Button({
    children: "Subscribe",
    fullWidth: true,
    onClick: () => {
      close();
      toast("Check your email to verify your alert subscription.", "success");
    },
  });
  const body = el("div", { style: "display:flex;flex-direction:column;gap:var(--tl-space-5)" }, [
    el("p", { style: "margin:0;color:var(--tl-text-2);font-size:var(--tl-text-base)" }, [
      "Get notified when your Health Factor drops or pool APY moves. Email alerts via the Turbolong alerts service.",
    ]),
    el("label", { style: "display:flex;gap:var(--tl-space-3);align-items:center;font-size:var(--tl-text-base);color:var(--tl-text);cursor:pointer" }, [
      el("input", { type: "checkbox", checked: true }),
      el("span", {}, ["Health Factor (Liquidation) Alerts"]),
    ]),
    el("label", { style: "display:flex;gap:var(--tl-space-3);align-items:center;font-size:var(--tl-text-base);color:var(--tl-text);cursor:pointer" }, [
      el("input", { type: "checkbox", checked: true }),
      el("span", {}, ["APY Alerts"]),
    ]),
    email,
    submit,
  ]);
  const node = Modal({ open: true, title: "Set up alerts", width: 400, onClose: () => close(), children: body });
  close = mountModal(node);
}

export function openAppModal(name: "alerts" | "shortcuts" | "tour"): void {
  if (name === "shortcuts") openShortcuts();
  else if (name === "alerts") openAlerts();
  else if (name === "tour") startTour();
}
