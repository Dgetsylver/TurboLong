import type { Meta, StoryObj } from "@storybook/html";

interface AprRow {
  label: string;
  value: string;
  color?: string;
}

interface AprCardArgs {
  title: "Supply" | "Borrow";
  baseApr: number;
  blndEmissions: number;
  extraRows: AprRow[];
}

function renderAprCard({ title, baseApr, blndEmissions, extraRows }: AprCardArgs): string {
  const totalApr = baseApr + blndEmissions;
  const isSupply = title === "Supply";
  const primaryColor = isSupply ? "#2ea043" : "#f85149";

  const extraHtml = extraRows
    .map(
      (r) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
        <span style="color:var(--color-text-muted,#8b949e);font-size:12px;">${r.label}</span>
        <span style="color:${r.color ?? "var(--color-text,#e6edf3)"};font-size:12px;font-weight:600;">${r.value}</span>
      </div>`
    )
    .join("");

  return `
    <div class="apr-card" style="
      width:200px;
      background:var(--color-surface,#161b22);
      border:1px solid var(--color-border,#21262d);
      border-radius:8px;
      padding:12px 16px;
    ">
      <div class="apr-card-label" style="
        font-size:11px;
        text-transform:uppercase;
        letter-spacing:0.05em;
        color:var(--color-text-muted,#8b949e);
        margin-bottom:8px;
      ">${title}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:12px;color:var(--color-text-muted,#8b949e);">Base APR</span>
        <span style="font-size:14px;font-weight:700;color:${primaryColor};">${baseApr.toFixed(2)}%</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:8px;border-bottom:1px solid var(--color-border,#21262d);margin-bottom:8px;">
        <span style="font-size:12px;color:var(--color-text-muted,#8b949e);">BLND emissions</span>
        <span style="font-size:12px;font-weight:600;color:#d29922;">+${blndEmissions.toFixed(2)}%</span>
      </div>
      ${extraHtml}
      <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid var(--color-border,#21262d);margin-top:${extraRows.length ? "8px" : "0"};">
        <span style="font-size:12px;color:var(--color-text,#e6edf3);font-weight:600;">Total APY</span>
        <span style="font-size:15px;font-weight:700;color:${primaryColor};">${totalApr.toFixed(2)}%</span>
      </div>
    </div>
  `;
}

const meta: Meta<AprCardArgs> = {
  title: "Components/APR Card",
  tags: ["autodocs"],
  render: (args) => renderAprCard(args),
  argTypes: {
    title:         { control: { type: "select" }, options: ["Supply", "Borrow"] },
    baseApr:       { control: { type: "number", min: 0, max: 50, step: 0.01 } },
    blndEmissions: { control: { type: "number", min: 0, max: 20, step: 0.01 } },
  },
};

export default meta;
type Story = StoryObj<AprCardArgs>;

export const SupplyCard: Story = {
  args: {
    title: "Supply",
    baseApr: 9.84,
    blndEmissions: 1.23,
    extraRows: [],
  },
};

export const BorrowCard: Story = {
  args: {
    title: "Borrow",
    baseApr: 5.12,
    blndEmissions: 0.45,
    extraRows: [],
  },
};

export const SupplyWithExtras: Story = {
  args: {
    title: "Supply",
    baseApr: 7.5,
    blndEmissions: 2.1,
    extraRows: [
      { label: "Protocol fee",  value: "-0.50%", color: "#f85149" },
      { label: "Compounding",   value: "+0.12%", color: "#2ea043" },
    ],
  },
};
