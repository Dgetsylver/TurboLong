import "./metricHero.css";
import { el, type Child } from "./el";

export interface MetricHeroProps {
  label: Child | Child[];
  /** Pre-formatted value, rendered in 24px mono. */
  value: Child | Child[];
  /** Optional caption under the value. */
  sub?: Child | Child[];
  /** @default "default" */
  tone?: "default" | "primary" | "success" | "warning" | "danger";
  id?: string;
  title?: string;
}

const toArr = (c: Child | Child[]): Child[] => (Array.isArray(c) ? c : [c]);

/** Large centered metric for the position summary row — 24px mono value over an uppercase label. */
export function MetricHero(props: MetricHeroProps): HTMLDivElement {
  const { label, value, sub, tone = "default", id, title } = props;

  const kids: Child[] = [
    el("span", { class: "tl-metric-hero__label" }, toArr(label)),
    el("span", { class: `tl-metric-hero__value tl-metric-hero__value--${tone}` }, toArr(value)),
  ];
  if (sub) kids.push(el("span", { class: "tl-metric-hero__sub" }, toArr(sub)));

  return el(
    "div",
    {
      class: "tl-metric-hero",
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
    },
    kids,
  ) as HTMLDivElement;
}
