// T3.5 — lightweight first-visit onboarding tour.
//
// A dismissible, centered multi-step overlay (no anchored-tooltip positioning,
// so it is robust across breakpoints). Shows once per browser unless the user
// re-opens it; "Don't show again" persists the dismissal. Fully translated via
// the i18n runtime.

import { t } from "./i18n.ts";

const DONE_KEY = "tl_tour_done";

interface Step {
  titleKey: string;
  bodyKey: string;
}

const STEPS: Step[] = [
  { titleKey: "tour.welcome.title", bodyKey: "tour.welcome.body" },
  { titleKey: "tour.trade.title", bodyKey: "tour.trade.body" },
  { titleKey: "tour.vault.title", bodyKey: "tour.vault.body" },
  { titleKey: "tour.compare.title", bodyKey: "tour.compare.body" },
];

function tourSeen(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* ignore */
  }
}

let overlay: HTMLDivElement | null = null;
let step = 0;
let dontShow = true;
let trigger: HTMLElement | null = null;
let trapHandler: ((e: KeyboardEvent) => void) | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function close(): void {
  if (dontShow) markSeen();
  if (trapHandler) {
    document.removeEventListener("keydown", trapHandler);
    trapHandler = null;
  }
  overlay?.remove();
  overlay = null;
  // Return focus to whatever opened the tour (#10).
  if (trigger && document.contains(trigger)) trigger.focus();
  trigger = null;
}

function render(): void {
  if (!overlay) return;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  const dots = STEPS.map((_, i) => `<span class="tour-dot${i === step ? " active" : ""}"></span>`).join("");
  overlay.innerHTML = `
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <button class="tour-skip" id="tour-skip">${t("tour.skip")}</button>
      <h3 class="tour-title" id="tour-title">${t(s.titleKey)}</h3>
      <p class="tour-body">${t(s.bodyKey)}</p>
      <div class="tour-dots">${dots}</div>
      <label class="tour-dontshow"><input type="checkbox" id="tour-dontshow" ${dontShow ? "checked" : ""}/> ${t("tour.dontShow")}</label>
      <div class="tour-actions">
        ${step > 0 ? `<button class="btn btn-ghost" id="tour-back">${t("tour.back")}</button>` : `<span></span>`}
        <button class="btn btn-primary" id="tour-next">${last ? t("tour.done") : t("tour.next")}</button>
      </div>
    </div>`;

  (overlay.querySelector("#tour-skip") as HTMLElement)?.addEventListener("click", close);
  (overlay.querySelector("#tour-back") as HTMLElement)?.addEventListener("click", () => {
    step = Math.max(0, step - 1);
    render();
  });
  (overlay.querySelector("#tour-next") as HTMLElement)?.addEventListener("click", () => {
    if (last) {
      close();
      return;
    }
    step = Math.min(STEPS.length - 1, step + 1);
    render();
  });
  (overlay.querySelector("#tour-dontshow") as HTMLInputElement)?.addEventListener("change", (e) => {
    dontShow = (e.target as HTMLInputElement).checked;
  });

  // Move focus into the card after each (re)render (#10).
  const card = overlay.querySelector(".tour-card") as HTMLElement | null;
  const first = card?.querySelector<HTMLElement>(FOCUSABLE);
  requestAnimationFrame(() => first?.focus());
}

/** Open the tour (used by the help action and on first visit). */
export function startTour(): void {
  if (overlay) return;
  step = 0;
  dontShow = true;
  // Remember the trigger so focus can return on close (#10).
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay = document.createElement("div");
  overlay.className = "tour-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  // Trap Tab within the tour card and allow Escape to dismiss (#10).
  trapHandler = (e: KeyboardEvent) => {
    if (!overlay) return;
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const firstEl = items[0],
      lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };
  document.addEventListener("keydown", trapHandler);
  render();
}

function underE2E(): boolean {
  if (typeof window === "undefined") return false;
  if ((window as unknown as { __E2E__?: boolean }).__E2E__) return true;
  try {
    return new URLSearchParams(window.location.search).get("e2e") === "1";
  } catch {
    return false;
  }
}

/** Show the tour automatically the first time a visitor lands (never under E2E). */
export function maybeAutoStartTour(): void {
  if (underE2E()) return;
  if (!tourSeen()) startTour();
}
