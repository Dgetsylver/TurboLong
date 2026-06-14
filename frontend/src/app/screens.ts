/**
 * Screen registry. P2 placeholders — each real screen lands in its phase:
 *   Dashboard (P3) · Trade/Vault/Compare/Swap/Status (P4).
 * Replace the placeholder branches with imports of the real view modules.
 */
import { el, Card, Badge } from "../ui";
import type { View } from "./state";
import { dashboardScreen } from "../views/dashboard.screen";

const TITLES: Record<View, string> = {
  dashboard: "Dashboard",
  trade: "Trade",
  vault: "Vault",
  compare: "Compare",
  swap: "Swap",
  status: "Status",
};

function placeholder(view: View): HTMLElement {
  return Card({
    title: TITLES[view],
    action: Badge({ tone: "warning", children: "Building" }),
    children: el("p", { style: "color:var(--tl-text-2);font-size:var(--tl-text-base);margin:0" }, [
      `The ${TITLES[view]} screen is being rebuilt on the V3 design system. Shell + chrome are live; this view is wired next.`,
    ]),
  });
}

/** Build the screen for a view. Async so real screens can fetch on mount. */
export async function renderScreen(view: View): Promise<HTMLElement> {
  switch (view) {
    case "dashboard":
      return dashboardScreen();
    default:
      return placeholder(view);
  }
}
