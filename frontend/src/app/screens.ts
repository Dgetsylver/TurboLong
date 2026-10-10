/**
 * Screen registry for the V3 view layer. Each route delegates to its typed
 * screen builder; async work is owned by the screen so navigation stays thin.
 */
import { el, Card, Badge } from "../ui";
import type { View } from "./state";
import { dashboardScreen } from "../views/dashboard.screen";
import { tradeScreen } from "../views/trade";
import { statusScreen } from "../views/status";
import { vaultScreen } from "../views/vault";
import { compareScreen } from "../views/compare";
import { swapScreen } from "../views/swap";

const TITLES: Record<View, string> = {
  dashboard: "Dashboard",
  trade: "Trade",
  vault: "Vault",
  compare: "Compare",
  swap: "Swap",
  status: "Status",
};

/** Build the screen for a view. Async so real screens can fetch on mount. */
export async function renderScreen(view: View): Promise<HTMLElement> {
  switch (view) {
    case "dashboard":
      return dashboardScreen();
    case "trade":
      return tradeScreen();
    case "status":
      return statusScreen();
    case "vault":
      return vaultScreen();
    case "compare":
      return compareScreen();
    case "swap":
      return swapScreen();
    default:
      return Card({
        title: TITLES[view],
        action: Badge({ tone: "danger", children: "Unavailable" }),
        children: el("p", { style: "color:var(--tl-text-2);font-size:var(--tl-text-base);margin:0" }, [
          "This view is unavailable.",
        ]),
      });
  }
}
