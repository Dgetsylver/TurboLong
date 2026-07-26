import "./badge.css";
import { el, type Child } from "./el";

export interface BadgeProps {
  /** Tone follows the risk signal system. @default "neutral" */
  tone?: "neutral" | "primary" | "success" | "warning" | "danger" | "blnd";
  /** Leading status dot (glows for non-neutral tones). @default false */
  dot?: boolean;
  title?: string;
  id?: string;
  children?: Child | Child[];
}

/** Small uppercase status / tag pill. Tone maps to the risk signal system; `dot` adds a glowing status indicator. */
export function Badge(props: BadgeProps = {}): HTMLSpanElement {
  const { tone = "neutral", dot = false, title, id, children } = props;

  const cls = ["tl-badge", `tl-badge--${tone}`].join(" ");

  const kids: Child[] = dot ? [el("span", { class: "tl-badge__dot", "aria-hidden": "true" })] : [];
  const content = Array.isArray(children) ? children : [children];
  kids.push(...content);

  return el("span", { class: cls, ...(title ? { title } : {}), ...(id ? { id } : {}) }, kids) as HTMLSpanElement;
}
