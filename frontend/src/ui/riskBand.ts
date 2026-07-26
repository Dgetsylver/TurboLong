import "./riskBand.css";
import { el } from "./el";

export type RiskZone = "safe" | "caution" | "high" | "nearLiq";

export interface RiskBandProps {
  /** Active zone. @default "safe" */
  zone?: RiskZone;
  title?: string;
  id?: string;
}

interface Seg {
  key: RiskZone;
  label: string;
}

const SEGS: Seg[] = [
  { key: "safe", label: "Safe" },
  { key: "caution", label: "Caution" },
  { key: "high", label: "High risk" },
  { key: "nearLiq", label: "Near liq." },
];

/** Map a Health Factor number to a RiskZone (same thresholds as HealthFactor). */
export function zoneFromHF(hf: number): RiskZone {
  if (hf < 1.2) return "nearLiq";
  if (hf < 1.5) return "high";
  if (hf < 2.0) return "caution";
  return "safe";
}

/**
 * Four-segment risk indicator (Safe → Caution → High → Near liquidation).
 * The active zone lights up in its signal color; the others dim.
 */
export function RiskBand(props: RiskBandProps = {}): HTMLDivElement {
  const { zone = "safe", title, id } = props;
  const active = SEGS.find((s) => s.key === zone) ?? SEGS[0];

  const header = el("div", { class: "tl-riskband__head" }, [
    el("span", { class: "tl-riskband__title" }, ["Risk level"]),
    el("span", { class: `tl-riskband__value tl-riskband__value--${active.key}` }, [active.label]),
  ]);

  const track = el(
    "div",
    { class: "tl-riskband__track" },
    SEGS.map((s) =>
      el(
        "span",
        {
          class: `tl-riskband__seg tl-riskband__seg--${s.key}` + (s.key === zone ? " is-on" : ""),
        },
        [s.label],
      ),
    ),
  );

  return el(
    "div",
    {
      class: "tl-riskband",
      ...(title ? { title } : {}),
      ...(id ? { id } : {}),
    },
    [header, track],
  ) as HTMLDivElement;
}
