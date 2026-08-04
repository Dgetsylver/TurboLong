import "./apyChart.css";
import { chartGeometry } from "../compare_model";

export interface ApyChartProps {
  /** Series of APY values, oldest → newest. Needs at least 2 points. */
  data: number[];
  /** @default 320 */
  width?: number;
  /** @default 96 */
  height?: number;
  /** Line colour keyword. @default "primary" */
  tone?: "up" | "down" | "flat" | "primary";
  /** x-axis labels, drawn left → right beneath the plot. */
  ticks?: string[];
  /** Accessible label. */
  title?: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, v);
  }
  return node;
}

const TONE_VAR: Record<string, string> = {
  up: "var(--tl-success)",
  down: "var(--tl-danger)",
  flat: "var(--tl-text-3)",
  primary: "var(--tl-primary)",
};

const fmtPct = (n: number) => n.toFixed(2) + "%";

/**
 * Full-size APY history chart — line over a soft area fill, with min/max
 * gridlines and date ticks. The larger sibling of Sparkline: same geometry
 * source (compare_model.chartGeometry), enough room for axis labels.
 *
 * Uses a viewBox with `preserveAspectRatio="none"` so one built chart scales to
 * its container width; nothing is re-measured or re-laid-out on resize.
 */
export function ApyChart(props: ApyChartProps): HTMLElement {
  const { data, width = 320, height = 96, tone = "primary", ticks = [], title } = props;

  const root = document.createElement("div");
  root.className = "tl-apyc";

  const geo = chartGeometry(data, width, height);
  if (!geo) {
    root.classList.add("tl-apyc--empty");
    root.textContent = "Not enough history yet.";
    return root;
  }

  const color = TONE_VAR[tone] ?? TONE_VAR.primary;
  root.style.setProperty("--tl-apyc-color", color);

  const plot = svg("svg", {
    class: "tl-apyc__svg",
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    role: "img",
  }) as SVGSVGElement;
  plot.setAttribute(
    "aria-label",
    title ?? `APY history: ${fmtPct(geo.first)} to ${fmtPct(geo.last)}, low ${fmtPct(geo.min)}, high ${fmtPct(geo.max)}`,
  );

  // Gridlines sit at the series extremes, so the labels beside them are exact.
  for (const yy of [3, height - 3]) {
    plot.append(svg("line", { class: "tl-apyc__grid", x1: "0", x2: String(width), y1: String(yy), y2: String(yy) }));
  }
  plot.append(svg("path", { class: "tl-apyc__area", d: geo.area }));
  plot.append(svg("path", { class: "tl-apyc__line", d: geo.line }));
  plot.append(svg("circle", { class: "tl-apyc__dot", cx: String(geo.lastX), cy: String(geo.lastY), r: "2.5" }));

  const scale = document.createElement("div");
  scale.className = "tl-apyc__scale";
  for (const v of [geo.max, geo.min]) {
    const s = document.createElement("span");
    s.textContent = fmtPct(v);
    scale.append(s);
  }

  const body = document.createElement("div");
  body.className = "tl-apyc__body";
  body.append(plot, scale);
  root.append(body);

  if (ticks.length > 0) {
    const axis = document.createElement("div");
    axis.className = "tl-apyc__axis";
    for (const label of ticks) {
      const s = document.createElement("span");
      s.textContent = label;
      axis.append(s);
    }
    root.append(axis);
  }

  return root;
}
