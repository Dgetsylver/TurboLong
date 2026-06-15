import "./healthFactor.css";
import { el, type Child } from "./el";

export interface HealthFactorProps {
  /** Current health factor (e.g. 1.42). 1.0 = liquidation. */
  value: number;
  /** HF value treated as the "fully safe" right edge of the track. @default 3 */
  maxScale?: number;
  /** Show the "Health Factor" caption. @default true */
  showLabel?: boolean;
  /** Caption text. @default "Health Factor" (set "Account Health" for the pool-wide aggregate). */
  label?: Child | Child[];
  /** Override the native hover title on the caption. */
  labelTitle?: string;
  /** Extra class names appended to the root. */
  class?: string;
  id?: string;
}

export interface HealthZone {
  /** Token color reference for this zone. */
  tone: string;
  /** Short human label, e.g. "Near liquidation". */
  label: string;
}

/** Map a health factor to its signal zone (color tone + label). */
export function zoneFromHF(hf: number): HealthZone {
  if (hf < 1.2) return { tone: "var(--tl-danger)", label: "Near liquidation" };
  if (hf < 1.5) return { tone: "var(--tl-warning)", label: "High risk" };
  if (hf < 2.0) return { tone: "var(--tl-warning)", label: "Caution" };
  return { tone: "var(--tl-success)", label: "Safe" };
}

/**
 * Turbolong HealthFactor — the single most important risk readout. Shows the HF
 * value, color-coded per the signal system, over a track whose marker sits
 * between the liquidation point (1.0) and "safe" (>= maxScale). Below ~1.2 the
 * marker pulses red.
 */
export function HealthFactor(props: HealthFactorProps): HTMLDivElement {
  const {
    value,
    maxScale = 3,
    showLabel = true,
    label = "Health Factor",
    labelTitle,
    class: extraClass,
    id,
  } = props;

  const z = zoneFromHF(value);
  const pos = Math.max(0, Math.min(1, (value - 1) / (maxScale - 1))) * 100;
  const danger = value < 1.2;

  const cls = ["tl-hf", extraClass].filter(Boolean).join(" ");

  const labelKids = Array.isArray(label) ? label : [label];

  const header = el("div", { class: "tl-hf__header" }, [
    showLabel
      ? el(
          "span",
          {
            class: "tl-hf__label",
            title:
              labelTitle ||
              "How safe your position is. At a Health Factor of 1.0 your collateral is liquidated; higher is safer.",
          },
          labelKids,
        )
      : null,
    el("span", { class: "tl-hf__readout" }, [
      el("span", { class: "tl-hf__value", style: `color:${z.tone}` }, [value.toFixed(2)]),
      el("span", { class: "tl-hf__zone", style: `color:${z.tone}` }, [z.label]),
    ]),
  ]);

  const fill = el("div", { class: "tl-hf__fill", style: `width:${pos}%;background:${z.tone}` });
  const marker = el("div", {
    class: "tl-hf__marker" + (danger ? " is-danger" : ""),
    style: `left:${pos}%;background:${z.tone};box-shadow:0 0 var(--tl-space-3) ${z.tone}`,
  });

  const track = el("div", { class: "tl-hf__track" }, [
    el("div", { class: "tl-hf__gradient" }),
    fill,
    marker,
  ]);

  const scale = el("div", { class: "tl-hf__scale" }, [
    el("span", { class: "tl-hf__scale-liq" }, ["1.0 liq"]),
    el("span", {}, [`${maxScale.toFixed(1)}+ safe`]),
  ]);

  return el(
    "div",
    { class: cls, ...(id ? { id } : {}) },
    [header, track, scale],
  ) as HTMLDivElement;
}
