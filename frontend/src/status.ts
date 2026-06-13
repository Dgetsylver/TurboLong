// T3.5 — standalone status page logic (own Vite entry: status.html).
//
// Lightweight reachability checks against the protocol's external services.
// Intentionally independent of the main app bundle so the status page keeps
// working even if the app fails to boot. Translated via the i18n runtime.

import "./style.css";
import { initI18n, applyTranslations, t, cycleLang } from "./i18n.ts";

const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://soroban-rpc.creit.tech/";
const ALERTS_URL =
  (import.meta.env.VITE_ALERTS_WORKER_URL as string | undefined) ?? "https://turbolong-alerts.workers.dev";
const AQUARIUS_API =
  (import.meta.env.VITE_AQUARIUS_API as string | undefined) ?? "https://amm-api.aqua.network/api/external/v1";

type State = "operational" | "degraded" | "down" | "checking";

interface Service {
  id: string;
  labelKey: string;
  check: () => Promise<boolean>;
}

const SLOW_MS = 3000;
const TIMEOUT_MS = 8000;

/** Resolve true if the endpoint responds at all (any HTTP status = reachable). */
async function reachable(url: string, init?: RequestInit): Promise<boolean> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return !!res; // a thrown network error / timeout rejects → caught by the caller
}

const SERVICES: Service[] = [
  {
    id: "rpc",
    labelKey: "status.svc.rpc",
    check: () =>
      reachable(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      }),
  },
  { id: "alerts",    labelKey: "status.svc.alerts",    check: () => reachable(`${ALERTS_URL}/snapshots?limit=1`) },
  { id: "snapshots", labelKey: "status.svc.snapshots", check: () => reachable(`${ALERTS_URL}/snapshots?asset=USDC&limit=1`) },
  { id: "aquarius",  labelKey: "status.svc.aquarius",  check: () => reachable(AQUARIUS_API) },
];

function dotClass(state: State): string {
  return `status-dot status-dot-${state}`;
}

function stateLabel(state: State): string {
  return t(`status.${state === "checking" ? "checking" : state}`);
}

function renderRow(svc: Service, state: State): string {
  return `<div class="status-row" id="status-row-${svc.id}">
    <span class="${dotClass(state)}"></span>
    <span class="status-name">${t(svc.labelKey)}</span>
    <span class="status-badge status-badge-${state}">${stateLabel(state)}</span>
  </div>`;
}

async function runChecks(): Promise<void> {
  const list = document.getElementById("status-list");
  const banner = document.getElementById("status-banner");
  const checkedAt = document.getElementById("status-checked");
  if (!list) return;

  // Render all rows as "checking" first.
  list.innerHTML = SERVICES.map((s) => renderRow(s, "checking")).join("");

  const results = await Promise.all(
    SERVICES.map(async (svc) => {
      const start = performance.now();
      let state: State = "down";
      try {
        const ok = await svc.check();
        const elapsed = performance.now() - start;
        state = ok ? (elapsed > SLOW_MS ? "degraded" : "operational") : "down";
      } catch {
        state = "down";
      }
      const row = document.getElementById(`status-row-${svc.id}`);
      if (row) row.outerHTML = renderRow(svc, state);
      return state;
    }),
  );

  const allGood = results.every((s) => s === "operational");
  if (banner) {
    banner.className = `status-overall ${allGood ? "status-overall-good" : "status-overall-bad"}`;
    banner.textContent = allGood ? t("status.allGood") : t("status.someIssues");
  }
  if (checkedAt) {
    checkedAt.textContent = `${t("status.lastChecked")}: ${new Date().toLocaleTimeString()}`;
  }
}

function boot(): void {
  initI18n();
  applyTranslations();
  document.getElementById("status-refresh")?.addEventListener("click", () => void runChecks());
  document.getElementById("status-lang")?.addEventListener("click", () => {
    cycleLang();
    applyTranslations();
    void runChecks();
  });
  void runChecks();
  // Auto-refresh every 30s.
  setInterval(() => void runChecks(), 30_000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
