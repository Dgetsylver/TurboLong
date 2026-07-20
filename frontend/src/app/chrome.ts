/**
 * App chrome controllers: toast stack + transaction stepper. Imperative wrappers
 * around the ui/ components, mounted into fixed overlay containers on the body.
 */
import "./chrome.css";
import { el, TxStepper } from "../ui";

// ── Toast ────────────────────────────────────────────────────────────────────
let toastStack: HTMLElement | null = null;
function ensureToastStack(): HTMLElement {
  if (!toastStack) {
    toastStack = el("div", { class: "tl-toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

export type ToastType = "info" | "success" | "error";

/** Show a transient toast. `hash` adds a Stellar Expert link. */
export function toast(msg: string, type: ToastType = "info", hash?: string): void {
  const stack = ensureToastStack();
  const dot = el("span", { class: `tl-toast__dot tl-toast__dot--${type}` });
  const kids: (Node | string)[] = [dot, el("span", { class: "tl-toast__msg" }, [msg])];
  if (hash) {
    const a = el(
      "a",
      {
        class: "tl-toast__link",
        href: `https://stellar.expert/explorer/public/tx/${hash}`,
        target: "_blank",
        rel: "noopener",
      },
      ["View ↗"],
    );
    kids.push(a);
  }
  const node = el("div", { class: `tl-toast tl-toast--${type}` }, kids);
  stack.appendChild(node);
  // keep at most 3
  while (stack.childElementCount > 3) stack.firstElementChild?.remove();
  const ttl = type === "error" ? 9000 : hash ? 8000 : 5000;
  setTimeout(() => {
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 250);
  }, ttl);
}

// ── Transaction stepper ──────────────────────────────────────────────────────
let txMount: HTMLElement | null = null;
let txState: { steps: string[]; current: number; error: boolean } | null = null;

function ensureTxMount(): HTMLElement {
  if (!txMount) {
    txMount = el("div", { class: "tl-tx-mount" });
    document.body.appendChild(txMount);
  }
  return txMount;
}

function renderTx(): void {
  const mount = ensureTxMount();
  if (!txState) {
    mount.replaceChildren();
    return;
  }
  const node = TxStepper({ steps: txState.steps, current: txState.current, error: txState.error, onClose: txHide });
  mount.replaceChildren(...(node ? [node] : []));
}

/** Begin a stepper with ordered labels (e.g. ["Sign", "Submit", "Confirmed"]). */
export function txShow(steps: string[]): void {
  txState = { steps, current: 0, error: false };
  renderTx();
}
/** Set the in-progress step index (=== steps.length means all done). */
export function txStep(current: number, error = false): void {
  if (!txState) return;
  txState.current = current;
  txState.error = error;
  renderTx();
}
/** Dismiss the stepper after `delay` ms (0 = immediate). */
export function txHide(delay = 3000): void {
  if (delay <= 0) {
    txState = null;
    renderTx();
    return;
  }
  setTimeout(() => {
    txState = null;
    renderTx();
  }, delay);
}
