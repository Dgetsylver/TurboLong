import type { Meta, StoryObj } from "@storybook/html";

interface LeverageSliderArgs {
  value: number;
  min: number;
  max: number;
  showZones: boolean;
  expertMode: boolean;
}

function renderLeverageSlider({
  value,
  min,
  max,
  showZones,
  expertMode,
}: LeverageSliderArgs): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:360px;padding:16px;background:var(--color-surface,#161b22);border-radius:8px;";

  const zones = [
    { key: "conservative", label: "Conservative", pct: 0 },
    { key: "moderate",     label: "Moderate",     pct: 30 },
    { key: "aggressive",   label: "Aggressive",   pct: 55 },
    { key: "degen",        label: "Degen",         pct: 75 },
    ...(expertMode ? [{ key: "maxi-degen", label: "Maxi Degen", pct: 90 }] : []),
  ];

  const pct = ((value - min) / (max - min)) * 100;
  const hfEst = Math.max(1.01, 3.5 - (pct / 100) * 2.2);

  wrap.innerHTML = `
    <label style="display:flex;justify-content:space-between;font-size:13px;color:var(--color-text,#e6edf3);margin-bottom:8px;">
      <span>Leverage</span>
      <span style="font-family:monospace;font-weight:700;">${value.toFixed(1)}&times;</span>
    </label>
    <input
      type="range"
      class="slider"
      min="${min}" max="${max}" step="0.1"
      value="${value}"
      style="width:100%;margin-bottom:${showZones ? 28 : 8}px;"
    />
    ${showZones ? `
      <div class="slider-zones" style="display:flex;gap:4px;margin-bottom:12px;">
        ${zones.map(z => `
          <span class="slider-zone zone-${z.key}" style="flex:1;text-align:center;font-size:10px;padding:2px 0;border-radius:4px;background:var(--zone-${z.key}-bg,#21262d);color:var(--color-text-muted,#8b949e);">
            ${z.label}
          </span>
        `).join("")}
      </div>
    ` : ""}
    <div class="leverage-preview" style="font-size:12px;color:var(--color-text-muted,#8b949e);">
      <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--color-border,#21262d);">
        <span>Health Factor</span>
        <strong style="color:${hfEst < 1.2 ? "#f85149" : hfEst < 1.5 ? "#d29922" : "#2ea043"};">${hfEst.toFixed(3)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;">
        <span>Leverage</span>
        <strong>${value.toFixed(1)}&times;</strong>
      </div>
    </div>
  `;

  const slider = wrap.querySelector("input")!;
  slider.addEventListener("input", () => {
    const label = wrap.querySelector("label span:last-child")!;
    label.textContent = `${parseFloat(slider.value).toFixed(1)}×`;
  });

  return wrap;
}

const meta: Meta<LeverageSliderArgs> = {
  title: "Components/Leverage Slider",
  tags: ["autodocs"],
  render: (args) => renderLeverageSlider(args),
  argTypes: {
    value:      { control: { type: "range", min: 1.1, max: 12.9, step: 0.1 } },
    min:        { control: { type: "number" } },
    max:        { control: { type: "number" } },
    showZones:  { control: "boolean" },
    expertMode: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<LeverageSliderArgs>;

export const Default: Story = {
  args: { value: 2.0, min: 1.1, max: 12.9, showZones: true, expertMode: false },
};

export const HighLeverage: Story = {
  args: { value: 8.5, min: 1.1, max: 12.9, showZones: true, expertMode: false },
};

export const ExpertMode: Story = {
  args: { value: 10.0, min: 1.1, max: 12.9, showZones: true, expertMode: true },
};

export const NoZones: Story = {
  args: { value: 3.0, min: 1.1, max: 12.9, showZones: false, expertMode: false },
};
