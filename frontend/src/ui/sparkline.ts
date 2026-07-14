import "./sparkline.css";

export interface SparklineProps {
  /** Series of numbers (oldest → newest). Needs at least 2 points. */
  data: number[];
  /** @default 64 */
  width?: number;
  /** @default 20 */
  height?: number;
  /** Line color. "auto" = green if the series rises end-to-end, else red. @default "auto" */
  tone?: "auto" | "up" | "down" | "primary" | "flat" | string;
  /** @default 1.5 */
  strokeWidth?: number;
  /** Dot on the latest point. @default true */
  showDot?: boolean;
  /** Accessible label; falls back to a generic description. */
  title?: string;
  id?: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an SVG element (el() uses createElement, which can't make SVG nodes). */
function svg(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, v);
  }
  return node;
}

/** Resolve a tone keyword to a CSS color; pass-through for raw CSS colors. */
export function colorForTone(tone: string, rises: boolean): string {
  if (tone === "auto") return rises ? "var(--tl-success)" : "var(--tl-danger)";
  if (tone === "up") return "var(--tl-success)";
  if (tone === "down") return "var(--tl-danger)";
  if (tone === "primary") return "var(--tl-primary)";
  if (tone === "flat") return "var(--tl-text-3)";
  return tone;
}

/** Tiny inline trend line for APY / rate history. Mono-feel SVG polyline. */
export function Sparkline(props: SparklineProps): SVGSVGElement {
  const { data = [], width = 64, height = 20, tone = "auto", strokeWidth = 1.5, showDot = true, title, id } = props;

  const root = svg("svg", {
    class: "tl-spark",
    width: String(width),
    height: String(height),
    ...(id ? { id } : {}),
  }) as SVGSVGElement;
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", title ?? "Trend line");

  // Fewer than 2 points: render an empty, correctly-sized canvas.
  if (!data || data.length < 2) return root;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = strokeWidth + (showDot ? 1.5 : 0);
  const x = (i: number) => (i / (data.length - 1)) * (width - pad * 2) + pad;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const last = data[data.length - 1];
  const rises = last >= data[0];
  const color = colorForTone(tone, rises);

  root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  root.style.setProperty("--tl-spark-color", color);

  root.append(
    svg("polyline", {
      class: "tl-spark__line",
      points: pts,
      "stroke-width": String(strokeWidth),
    }),
  );

  if (showDot) {
    root.append(
      svg("circle", {
        class: "tl-spark__dot",
        cx: x(data.length - 1).toFixed(1),
        cy: y(last).toFixed(1),
        r: String(strokeWidth + 0.5),
      }),
    );
  }

  return root;
}
