/**
 * Turbolong — app entry (thin boot).
 * The view layer is rebuilt on the V3 design system: typed render functions in
 * src/ui (components) + src/views (screens), orchestrated by src/app (shell,
 * router, state, wallet, chrome, modals). The data layer (blend.ts, defindex.ts,
 * aquarius*, history, i18n, locales, tour) is reused unchanged.
 */

// MUST be first: installs a global Buffer before the Ledger module loads.
import "./polyfills.ts";
import "./tokens/styles.css";

import { initI18n } from "./i18n.ts";
import { setNetwork, type NetworkMode } from "./blend.ts";
import { setState } from "./app/state.ts";
import { initTheme } from "./app/theme.ts";
import { initWalletKit, installE2EHarness } from "./app/wallet.ts";
import { buildShell } from "./app/shell.ts";
import { initRouter } from "./app/router.ts";
import { showDisclaimerIfNeeded } from "./app/modals.ts";

async function boot(): Promise<void> {
  initI18n();
  initTheme();

  // Restore persisted network + wallet session (display state; the kit keeps the
  // selected wallet, so signing still routes through it after a reload).
  const savedNet = (localStorage.getItem("networkMode") as NetworkMode | null) ?? "mainnet";
  setNetwork(savedNet);
  initWalletKit(savedNet);
  setState({ network: savedNet });

  const savedAddr = localStorage.getItem("walletAddress");
  if (savedAddr) setState({ userAddress: savedAddr, connected: true });

  // Hermetic E2E mocks when loaded under the harness (?e2e=1).
  await installE2EHarness();

  const { root, main } = buildShell();
  document.getElementById("root")!.replaceChildren(root);
  initRouter(main);

  // First-visit risk disclaimer (gate is visual; nav stays interactive behind it).
  void showDisclaimerIfNeeded();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
