import "./card.css";
import { el, type Child } from "./el";

export interface CardProps {
  /** Header title (15px/700). Omit for a bare card. */
  title?: Child;
  /** Right-aligned header slot (badge, button, data-freshness). */
  action?: Child;
  /** Brighten border on hover. @default true */
  hoverable?: boolean;
  /** Inline style applied to the inner body wrapper. */
  bodyStyle?: string;
  /** Inline style applied to the outer section. */
  style?: string;
  /** Extra class(es) appended to the section. */
  class?: string;
  id?: string;
  children?: Child | Child[];
}

/** Flat bordered surface — the workhorse container. 12px radius, 1px hairline, no shadow at rest. */
export function Card(props: CardProps = {}): HTMLElement {
  const { title, action, hoverable = true, bodyStyle, style, class: className, id, children } = props;

  const cls = ["tl-card", hoverable ? "tl-card--hoverable" : "", className || ""].filter(Boolean).join(" ");

  const header =
    title || action
      ? el("header", { class: "tl-card__header" }, [
          title ? el("h2", { class: "tl-card__title" }, [title]) : null,
          action || null,
        ])
      : null;

  const content = Array.isArray(children) ? children : [children];
  const body = el("div", { class: "tl-card__body", ...(bodyStyle ? { style: bodyStyle } : {}) }, content);

  return el("section", { class: cls, ...(style ? { style } : {}), ...(id ? { id } : {}) }, [header, body]);
}
