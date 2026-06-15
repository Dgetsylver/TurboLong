/**
 * Tiny DOM helper — the foundation of the vanilla-TS component library.
 * Mirrors the design-system ts-port pattern (design_handoff/ts-port/dashboard.ts):
 * components are pure functions that take typed props and return an HTMLElement,
 * styled via CSS classes bound to --tl-* tokens. No framework.
 */

export type Child = Node | string | null | undefined | false;
export type Attrs = Record<string, string>;

/** Create an element. `class`/`title` map to props; everything else → setAttribute. */
export function el(tag: string, attrs: Attrs = {}, children: Child[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "title") node.title = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c);
  }
  return node;
}

/** Attach a listener and return the node (chainable). */
export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  event: K,
  handler: (e: HTMLElementEventMap[K]) => void,
): HTMLElement {
  node.addEventListener(event, handler as EventListener);
  return node;
}

/** Replace a mount point's children with one or more nodes. */
export function mount(target: HTMLElement, ...nodes: Child[]): void {
  target.replaceChildren(...(nodes.filter((n) => n != null && n !== false) as Node[]));
}

// ── Shared formatters (mono, exact — per brand voice) ────────────────────────
export const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
export const moneyDec = (n: number, d = 2) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
export const lev = (n: number) => n.toFixed(1) + "×";
