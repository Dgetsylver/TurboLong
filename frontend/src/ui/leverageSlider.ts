import "./leverageSlider.css";
import { el, on, lev } from "./el";

export interface LeverageSliderProps {
  /** Current leverage multiplier. */
  value: number;
  /** Called with the new multiplier as the user drags. */
  onChange?: (value: number) => void;
  /** @default 1 */
  min?: number;
  /** @default 12.9 */
  max?: number;
  /** @default 0.1 */
  step?: number;
  id?: string;
  title?: string;
}

export interface LeverageZone {
  key: string;
  label: string;
  max: number;
}

/** Five risk zones (Conservative → Maxi-degen). Color is driven by per-zone CSS classes → tokens. */
export const ZONES: LeverageZone[] = [
  { key: "conservative", label: "Conservative", max: 2 },
  { key: "moderate", label: "Moderate", max: 4 },
  { key: "aggressive", label: "Aggressive", max: 7 },
  { key: "degen", label: "Degen", max: 10 },
  { key: "maxi", label: "Maxi-degen", max: Number.POSITIVE_INFINITY },
];

/** The active risk zone for a given leverage value. */
export function activeZone(v: number): LeverageZone {
  return ZONES.find((z) => v <= z.max) || ZONES[ZONES.length - 1];
}

/**
 * The signature leverage control — a range slider whose thumb, fill, and value
 * all shift color through the five risk zones as you drag. Controlled.
 */
export function LeverageSlider(props: LeverageSliderProps): HTMLDivElement {
  const { value, onChange, min = 1, max = 12.9, step = 0.1, id, title } = props;

  const input = el("input", {
    type: "range",
    class: "tl-lev__input",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    "aria-label": "Leverage multiplier",
  }) as HTMLInputElement;

  const val = el("span", { class: "tl-lev__value" }, [lev(value)]);

  const labels = el(
    "div",
    { class: "tl-lev__zones" },
    ZONES.map((zone) =>
      el("span", { class: `tl-lev__zone tl-lev__zone--${zone.key}` }, [zone.label]),
    ),
  );

  const row = el("div", { class: "tl-lev__row" }, [input, val]);

  const root = el(
    "div",
    { class: "tl-lev", ...(id ? { id } : {}), ...(title ? { title } : {}) },
    [row, labels],
  ) as HTMLDivElement;

  const render = (v: number) => {
    const z = activeZone(v);
    const range = max - min || 1;
    const pct = Math.max(0, Math.min(100, ((v - min) / range) * 100));
    root.style.setProperty("--tl-lev-pct", pct + "%");
    root.dataset.zone = z.key;
    val.textContent = lev(v);
  };

  render(value);

  on(input, "input", () => {
    const v = Number.parseFloat(input.value);
    render(v);
    onChange?.(v);
  });

  return root;
}
