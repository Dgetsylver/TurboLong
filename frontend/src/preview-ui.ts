/** Component gallery — verifies the ui/ library compiles + renders vs the design refs. Dev-only. */
import "./tokens/styles.css";
import {
  el,
  Button,
  Badge,
  Card,
  AssetTab,
  StatCard,
  MetricHero,
  Input,
  Sparkline,
  Select,
  HealthFactor,
  RiskBand,
  zoneFromHF,
  LeverageSlider,
  Tooltip,
  Modal,
  Skeleton,
  TxStepper,
} from "./ui";

const root = document.getElementById("gallery")!;
root.style.cssText = "max-width:1000px;margin:0 auto;padding:32px;display:flex;flex-direction:column;gap:24px";

function section(title: string, ...nodes: (Node | string)[]): HTMLElement {
  return el("section", {}, [
    el(
      "h2",
      { style: "font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--tl-text-3);margin:0 0 12px" },
      [title],
    ),
    el("div", { style: "display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start" }, nodes),
  ]);
}

root.append(
  section(
    "Button",
    Button({ children: "Primary" }),
    Button({ variant: "secondary", children: "Secondary" }),
    Button({ variant: "ghost", children: "Ghost" }),
    Button({ variant: "danger", children: "Close" }),
    Button({ loading: true, children: "Loading" }),
    Button({ size: "lg", children: "Confirm & Open" }),
  ),
  section(
    "Badge",
    Badge({ children: "Neutral" }),
    Badge({ tone: "primary", children: "Looped" }),
    Badge({ tone: "success", dot: true, children: "Operational" }),
    Badge({ tone: "warning", children: "Frozen" }),
    Badge({ tone: "danger", children: "Near liq" }),
    Badge({ tone: "blnd", children: "BLND" }),
  ),
  section(
    "AssetTab",
    AssetTab({ symbol: "USDC", active: true }),
    AssetTab({ symbol: "XLM" }),
    AssetTab({ symbol: "EURC", label: "Euro" }),
  ),
  section(
    "StatCard",
    el("div", { style: "display:grid;grid-template-columns:repeat(4,1fr);gap:8px;flex:1;min-width:600px" }, [
      StatCard({ label: "Total supplied", value: "$2.4M" }),
      StatCard({ label: "Available", value: "$350K" }),
      StatCard({ label: "Utilization", value: "85.2%", tone: "warning", bar: 85 }),
      StatCard({ label: "Collateral factor", value: "0.00", tone: "danger" }),
    ]),
  ),
  section(
    "MetricHero",
    el("div", { style: "display:grid;grid-template-columns:repeat(3,1fr);gap:10px;flex:1;min-width:600px" }, [
      MetricHero({ label: "Your equity", value: "$12,480" }),
      MetricHero({ label: "Leverage", value: "5.0×", tone: "warning" }),
      MetricHero({ label: "Net APY", value: "+19.8%", sub: "projected", tone: "success" }),
    ]),
  ),
  section("Input", Input({ value: "1000", suffix: "USDC", onMax: () => {} })),
  section("Select", Select({ options: ["USDC", "XLM", "EURC"], value: "USDC" })),
  section(
    "Sparkline",
    Sparkline({ data: [5.2, 5.6, 5.4, 6.0, 5.9, 6.3, 6.1, 6.4] }),
    Sparkline({ data: [6.4, 6.1, 5.5, 5.0, 4.6, 4.2], tone: "auto" }),
  ),
  section(
    "HealthFactor",
    el("div", { style: "min-width:280px" }, [HealthFactor({ value: 1.42, label: "Account Health" })]),
    el("div", { style: "min-width:280px" }, [HealthFactor({ value: 1.08 })]),
  ),
  section("RiskBand", el("div", { style: "min-width:280px" }, [RiskBand({ zone: zoneFromHF(1.42) })])),
  section(
    "LeverageSlider",
    el("div", { style: "min-width:420px" }, [LeverageSlider({ value: 3.0, onChange: () => {} })]),
  ),
  section(
    "Tooltip",
    el("span", { style: "color:var(--tl-text-2)" }, [
      "Health Factor ",
      Tooltip({ text: "Σ(collateral × c_factor) ÷ Σ(debt). Below 1.0 = liquidation." }),
    ]),
  ),
  section("Skeleton", Skeleton({ width: 80 }), Skeleton({ width: 120, height: 24 })),
);

// Floating overlays
root.append(TxStepper({ steps: ["Sign", "Submit", "Confirmed"], current: 1 })!);
const modal = Modal({
  open: false,
  title: "Confirm & open",
  children: el("p", { style: "color:var(--tl-text-2);font-size:13px" }, [
    "You may lose your entire deposit. Leverage amplifies liquidation risk.",
  ]),
  footer: el("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
    Button({ variant: "ghost", children: "Cancel" }),
    Button({ children: "Confirm" }),
  ]),
});
if (modal) root.append(modal);
