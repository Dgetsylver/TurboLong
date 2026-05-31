import type { Meta, StoryObj } from "@storybook/html";

interface StatCardArgs {
  label: string;
  value: string;
  sublabel?: string;
  trend?: "up" | "down" | "neutral";
  skeleton: boolean;
}

function renderStatCard({ label, value, sublabel, trend, skeleton }: StatCardArgs): string {
  const trendColor =
    trend === "up"   ? "#2ea043" :
    trend === "down" ? "#f85149" :
                       "var(--color-text-muted,#8b949e)";
  const trendIcon =
    trend === "up"   ? "↑" :
    trend === "down" ? "↓" :
                       "";

  const valueHtml = skeleton
    ? `<span class="skeleton" style="display:inline-block;width:80px;height:20px;border-radius:4px;background:var(--color-border,#21262d);">&nbsp;</span>`
    : `<span style="font-size:18px;font-weight:700;color:var(--color-text,#e6edf3);">${value}</span>`;

  return `
    <div class="stat-card" style="
      background:var(--color-surface,#161b22);
      border:1px solid var(--color-border,#21262d);
      border-radius:8px;
      padding:14px 16px;
      min-width:140px;
    ">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-muted,#8b949e);margin-bottom:6px;">
        ${label}
      </div>
      <div style="display:flex;align-items:baseline;gap:6px;">
        ${valueHtml}
        ${trend && !skeleton ? `<span style="font-size:12px;color:${trendColor};">${trendIcon}</span>` : ""}
      </div>
      ${sublabel && !skeleton ? `
        <div style="font-size:11px;color:var(--color-text-muted,#8b949e);margin-top:4px;">${sublabel}</div>
      ` : ""}
    </div>
  `;
}

const meta: Meta<StatCardArgs> = {
  title: "Components/Stat Card",
  tags: ["autodocs"],
  render: (args) => renderStatCard(args),
  argTypes: {
    label:    { control: "text" },
    value:    { control: "text" },
    sublabel: { control: "text" },
    trend:    { control: { type: "select" }, options: ["up", "down", "neutral", undefined] },
    skeleton: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<StatCardArgs>;

export const HealthFactor: Story = {
  args: {
    label: "Health Factor",
    value: "1.847",
    sublabel: "Safe",
    trend: "up",
    skeleton: false,
  },
};

export const TotalSupply: Story = {
  args: {
    label: "Total Supply",
    value: "$12,400.00",
    sublabel: "1,240 CETES",
    trend: "neutral",
    skeleton: false,
  },
};

export const Loading: Story = {
  args: {
    label: "Max Leverage",
    value: "—",
    skeleton: true,
  },
};

export const NegativeTrend: Story = {
  args: {
    label: "Net APY",
    value: "-1.23%",
    sublabel: "Reduce leverage",
    trend: "down",
    skeleton: false,
  },
};
