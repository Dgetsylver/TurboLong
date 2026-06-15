import "./statCard.css";
import { el, type Child } from "./el";

export interface StatCardProps {
  label: Child | Child[];
  /** Pre-formatted value, rendered in mono. */
  value: Child | Child[];
  /** @default "default" */
  tone?: "default" | "primary" | "success" | "warning" | "danger" | "blnd";
  /** 0–100 fill for an optional utilization bar. Omit to hide. */
  bar?: number;
  class?: string;
  title?: string;
  id?: string;
}

/** Compact pool-stat tile: uppercase label + mono value, optional utilization bar. */
export function StatCard(props: StatCardProps): HTMLDivElement {
  const { label, value, tone = "default", bar, class: className, title, id } = props;

  const cls = ["tl-stat", `tl-stat--${tone}`, className].filter(Boolean).join(" ");

  const labelKids = Array.isArray(label) ? label : [label];
  const valueKids = Array.isArray(value) ? value : [value];

  const kids: Child[] = [
    el("span", { class: "tl-stat__label" }, labelKids),
    el("span", { class: "tl-stat__value" }, valueKids),
  ];

  if (bar != null) {
    const fill = el("div", { class: "tl-stat__fill" });
    fill.style.width = `${Math.max(0, Math.min(100, bar))}%`;
    kids.push(el("div", { class: "tl-stat__track" }, [fill]));
  }

  return el(
    "div",
    { class: cls, ...(title ? { title } : {}), ...(id ? { id } : {}) },
    kids,
  ) as HTMLDivElement;
}
