import type { Meta, StoryObj } from "@storybook/html";

interface HfBadgeArgs {
  value: number;
  label?: string;
}

function renderHfBadge({ value, label = "Health Factor" }: HfBadgeArgs): string {
  const color =
    value >= 1.5 ? "var(--color-success, #2ea043)" :
    value >= 1.2 ? "var(--color-warn, #d29922)" :
                   "var(--color-danger, #f85149)";

  const displayVal = isFinite(value) ? value.toFixed(3) : "∞";

  return `
    <div style="
      display:inline-flex;
      flex-direction:column;
      align-items:center;
      gap:4px;
      font-family: 'JetBrains Mono', monospace;
    ">
      <span style="font-size:11px;color:var(--color-text-muted,#8b949e);text-transform:uppercase;letter-spacing:0.05em;">
        ${label}
      </span>
      <span style="
        font-size:22px;
        font-weight:700;
        color:${color};
        padding:4px 12px;
        border:2px solid ${color};
        border-radius:6px;
      ">
        ${displayVal}
      </span>
    </div>
  `;
}

const meta: Meta<HfBadgeArgs> = {
  title: "Components/HF Badge",
  tags: ["autodocs"],
  render: (args) => renderHfBadge(args),
  argTypes: {
    value: { control: { type: "number", min: 1, max: 5, step: 0.05 } },
    label: { control: "text" },
  },
};

export default meta;
type Story = StoryObj<HfBadgeArgs>;

export const Safe: Story = {
  args: { value: 1.85, label: "Health Factor" },
};

export const Warning: Story = {
  args: { value: 1.25, label: "Health Factor" },
};

export const Critical: Story = {
  args: { value: 1.05, label: "Health Factor" },
};

export const Infinite: Story = {
  args: { value: Infinity, label: "Health Factor" },
};
