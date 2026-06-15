import "./status.css";

/**
 * Status screen (in-app) — live health of the protocol's external services.
 *
 * Ports the reachability logic from the standalone status page (src/status.ts):
 * the SERVICES list, reachable(), the runChecks() timing→state heuristic, and
 * the state→label/dot mapping. The view is rebuilt with the V3 design system
 * (ui Badge + --tl-* tokens) instead of the standalone page's raw HTML/CSS.
 *
 * No wallet: this screen makes plain reachability requests against the same
 * endpoints/env vars status.ts uses and auto-refreshes every 60s.
 */
import { el, Badge } from "../ui";
import { t } from "../i18n";

// ── Endpoints / env vars (identical to src/status.ts) ────────────────────────
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://soroban-rpc.creit.tech/";
const ALERTS_URL =
  (import.meta.env.VITE_ALERTS_WORKER_URL as string | undefined) ??
  "https://turbolong-alerts.workers.dev";
const AQUARIUS_API =
  (import.meta.env.VITE_AQUARIUS_API as string | undefined) ??
  "https://amm-api.aqua.network/api/external/v1";

type State = "operational" | "degraded" | "down" | "checking";

interface Service {
  id: string;
  labelKey: string;
  check: () => Promise<boolean>;
}

const SLOW_MS = 3000;
const TIMEOUT_MS = 8000;
const REFRESH_MS = 60_000;

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
  { id: "alerts", labelKey: "status.svc.alerts", check: () => reachable(`${ALERTS_URL}/snapshots?limit=1`) },
  {
    id: "snapshots",
    labelKey: "status.svc.snapshots",
    check: () => reachable(`${ALERTS_URL}/snapshots?asset=USDC&limit=1`),
  },
  { id: "aquarius", labelKey: "status.svc.aquarius", check: () => reachable(AQUARIUS_API) },
];

// ── state → presentation ─────────────────────────────────────────────────────
const BADGE_TONE: Record<State, "neutral" | "success" | "warning" | "danger"> = {
  operational: "success",
  degraded: "warning",
  down: "danger",
  checking: "neutral",
};

function stateLabel(state: State): string {
  return t(`status.${state === "checking" ? "checking" : state}`);
}

/** One service row: status dot + name + ui Badge. */
function renderRow(svc: Service, state: State): HTMLElement {
  return el("div", { class: "tl-status__row", id: `tl-status-row-${svc.id}` }, [
    el("span", { class: "tl-status__name" }, [
      el("span", { class: `tl-status__dot tl-status__dot--${state}`, "aria-hidden": "true" }),
      t(svc.labelKey),
    ]),
    Badge({ tone: BADGE_TONE[state], dot: state !== "checking", children: stateLabel(state) }),
  ]);
}

/** Build the Status view. Renders a "checking" skeleton immediately; fills async. */
export function statusScreen(): HTMLElement {
  const root = el("div", { class: "tl-status" });

  const title = el("h1", { class: "tl-status__title" }, [t("status.title")]);
  const sub = el("p", { class: "tl-status__sub" }, [t("status.subtitle")]);
  const head = el("div", { class: "tl-status__head" }, [title, sub]);

  const bannerDot = el("span", { class: "tl-status__banner-dot", "aria-hidden": "true" });
  const bannerText = el("span", {}, [t("status.checking")]);
  const banner = el(
    "div",
    { class: "tl-status__banner", role: "status", "aria-live": "polite" },
    [bannerDot, bannerText],
  );

  const list = el("div", { class: "tl-status__list" });
  list.replaceChildren(...SERVICES.map((s) => renderRow(s, "checking")));

  const checkedAt = el("span", { class: "tl-mono" });
  const foot = el("p", { class: "tl-status__foot" }, [
    `${t("status.lastChecked")} `,
    checkedAt,
    " · ",
    t("status.autoRefresh"),
  ]);

  root.replaceChildren(head, banner, list, foot);

  async function runChecks(): Promise<void> {
    // Reset rows to "checking" before re-probing.
    for (const svc of SERVICES) {
      const row = root.querySelector<HTMLElement>(`#tl-status-row-${svc.id}`);
      if (row) row.replaceWith(renderRow(svc, "checking"));
    }

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
        const row = root.querySelector<HTMLElement>(`#tl-status-row-${svc.id}`);
        if (row) row.replaceWith(renderRow(svc, state));
        return state;
      }),
    );

    const allGood = results.every((s) => s === "operational");
    banner.className = `tl-status__banner ${allGood ? "tl-status__banner--good" : "tl-status__banner--bad"}`;
    bannerText.textContent = allGood ? t("status.allGood") : t("status.someIssues");
    checkedAt.textContent = new Date().toLocaleTimeString();
  }

  // Kick off immediately, then auto-refresh while the screen is mounted.
  void runChecks();
  const timer = window.setInterval(() => void runChecks(), REFRESH_MS);

  // Stop polling once the root leaves the DOM (router swaps views).
  const obs = new MutationObserver(() => {
    if (!root.isConnected) {
      window.clearInterval(timer);
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  return root;
}
