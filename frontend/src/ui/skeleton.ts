import "./skeleton.css";
import { el } from "./el";

export interface SkeletonProps {
  /** @default "100%" */
  width?: number | string;
  /** @default 14 */
  height?: number | string;
  /** Corner radius in px. @default 4 */
  radius?: number;
  /** Extra inline styles, merged last (overrides sizing). */
  style?: Partial<CSSStyleDeclaration>;
  class?: string;
  id?: string;
  title?: string;
}

const dim = (v: number | string): string => (typeof v === "number" ? `${v}px` : v);

/** Shimmering loading placeholder. Size it to the content it replaces to avoid layout shift. */
export function Skeleton(props: SkeletonProps = {}): HTMLSpanElement {
  const { width = "100%", height = 14, radius = 4, style, class: cls, id, title } = props;

  const node = el("span", {
    class: ["tl-skel", cls].filter(Boolean).join(" "),
    "aria-hidden": "true",
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
  }) as HTMLSpanElement;

  node.style.width = dim(width);
  node.style.height = dim(height);
  node.style.borderRadius = `${radius}px`;
  if (style) Object.assign(node.style, style);

  return node;
}
