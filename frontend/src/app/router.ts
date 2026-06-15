/**
 * View router. Owns the #app-main mount; on state.view change it builds the
 * matching screen. Screens are async builders so they can fetch on mount.
 * P2 ships placeholder screens — replaced by the real ones in P3+.
 */
import { getState, subscribe, type View } from "./state";
import { renderScreen } from "./screens";

let mainEl: HTMLElement | null = null;
let currentView: View | null = null;
let token = 0;

async function mountView(view: View): Promise<void> {
  if (!mainEl) return;
  const myToken = ++token;
  const node = await renderScreen(view);
  // A newer navigation superseded this one mid-build — drop the stale result.
  if (myToken !== token || !mainEl) return;
  mainEl.replaceChildren(node);
  mainEl.scrollTop = 0;
}

export function initRouter(main: HTMLElement): void {
  mainEl = main;
  const sync = () => {
    const { view } = getState();
    if (view === currentView) return;
    currentView = view;
    void mountView(view);
  };
  subscribe(sync);
  sync();
}
