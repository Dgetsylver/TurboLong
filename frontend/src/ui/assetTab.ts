import "./assetTab.css";
import { el, type Child } from "./el";

export interface AssetTabProps {
  /** Asset ticker, rendered in mono (e.g. "USDC"). */
  symbol: string;
  /** Optional secondary label. */
  label?: Child | Child[];
  /** @default false */
  active?: boolean;
  title?: string;
  id?: string;
  onClick?: (e: MouseEvent) => void;
}

/** Pill-shaped asset selector (the row under the nav). Mono symbol + optional label; active is solid mint with a glow. */
export function AssetTab(props: AssetTabProps): HTMLButtonElement {
  const { symbol, label, active = false, title, id, onClick } = props;

  const cls = ["tl-asset-tab", active ? "is-active" : ""].filter(Boolean).join(" ");

  const kids: Child[] = [el("span", { class: "tl-asset-tab__sym" }, [symbol])];
  if (label != null && label !== false) {
    const labelKids = Array.isArray(label) ? label : [label];
    kids.push(el("span", { class: "tl-asset-tab__label" }, labelKids));
  }

  const btn = el(
    "button",
    { class: cls, type: "button", ...(title ? { title } : {}), ...(id ? { id } : {}) },
    kids,
  ) as HTMLButtonElement;
  if (onClick) btn.addEventListener("click", onClick);
  return btn;
}
