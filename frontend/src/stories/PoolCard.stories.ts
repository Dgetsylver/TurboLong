import type { Meta, StoryObj } from "@storybook/html";

interface PoolCardArgs {
  poolName: string;
  assetSymbol: string;
  supplyApr: number;
  borrowApr: number;
  maxLeverage: number;
  available: string;
  frozen: boolean;
}

function renderPoolCard(args: PoolCardArgs): string {
  const {
    poolName,
    assetSymbol,
    supplyApr,
    borrowApr,
    maxLeverage,
    available,
    frozen,
  } = args;

  const netApy = (supplyApr * maxLeverage - borrowApr * (maxLeverage - 1)).toFixed(2);

  return `
    <div style="width:320px;">
      ${frozen ? `
        <div class="pool-frozen-banner" style="
          background:rgba(248,81,73,0.12);
          border:1px solid #f85149;
          border-radius:6px;
          padding:8px 12px;
          font-size:12px;
          color:#f85149;
          margin-bottom:8px;
        ">
          ⚠ This pool is Admin Frozen. No new positions can be opened.
        </div>
      ` : ""}
      <div class="stat-card" style="
        background:var(--color-surface,#161b22);
        border:1px solid var(--color-border,#21262d);
        border-radius:8px;
        padding:16px;
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <span style="font-weight:600;color:var(--color-text,#e6edf3);">${poolName}</span>
          <span style="
            font-size:11px;
            background:var(--color-chip-bg,#21262d);
            color:var(--color-text-muted,#8b949e);
            padding:2px 8px;
            border-radius:12px;
          ">${assetSymbol}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
          <div>
            <div style="color:var(--color-text-muted,#8b949e);font-size:11px;margin-bottom:2px;">Supply APR</div>
            <div style="color:#2ea043;font-weight:600;">${supplyApr.toFixed(2)}%</div>
          </div>
          <div>
            <div style="color:var(--color-text-muted,#8b949e);font-size:11px;margin-bottom:2px;">Borrow APR</div>
            <div style="color:#f85149;font-weight:600;">${borrowApr.toFixed(2)}%</div>
          </div>
          <div>
            <div style="color:var(--color-text-muted,#8b949e);font-size:11px;margin-bottom:2px;">Max leverage</div>
            <div style="color:var(--color-text,#e6edf3);font-weight:600;">${maxLeverage.toFixed(1)}×</div>
          </div>
          <div>
            <div style="color:var(--color-text-muted,#8b949e);font-size:11px;margin-bottom:2px;">Available</div>
            <div style="color:var(--color-text,#e6edf3);font-weight:600;">${available}</div>
          </div>
        </div>
        <div style="
          margin-top:12px;
          padding-top:12px;
          border-top:1px solid var(--color-border,#21262d);
          display:flex;
          justify-content:space-between;
          align-items:center;
        ">
          <span style="font-size:12px;color:var(--color-text-muted,#8b949e);">Est. net APY at ${maxLeverage.toFixed(1)}×</span>
          <span style="font-weight:700;color:${parseFloat(netApy) > 0 ? "#2ea043" : "#f85149"};">${netApy}%</span>
        </div>
      </div>
    </div>
  `;
}

const meta: Meta<PoolCardArgs> = {
  title: "Components/Pool Card",
  tags: ["autodocs"],
  render: (args) => renderPoolCard(args),
  argTypes: {
    poolName:    { control: "text" },
    assetSymbol: { control: "text" },
    supplyApr:   { control: { type: "number", min: 0, max: 50, step: 0.1 } },
    borrowApr:   { control: { type: "number", min: 0, max: 50, step: 0.1 } },
    maxLeverage: { control: { type: "number", min: 1, max: 13, step: 0.1 } },
    available:   { control: "text" },
    frozen:      { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<PoolCardArgs>;

export const Etherfuse: Story = {
  args: {
    poolName: "Etherfuse",
    assetSymbol: "CETES",
    supplyApr: 9.84,
    borrowApr: 5.12,
    maxLeverage: 6.5,
    available: "482,310 USDC",
    frozen: false,
  },
};

export const Fixed: Story = {
  args: {
    poolName: "Fixed",
    assetSymbol: "USDC",
    supplyApr: 6.21,
    borrowApr: 4.88,
    maxLeverage: 8.2,
    available: "1,200,000 USDC",
    frozen: false,
  },
};

export const FrozenPool: Story = {
  args: {
    poolName: "YieldBlox",
    assetSymbol: "wETH",
    supplyApr: 4.5,
    borrowApr: 3.1,
    maxLeverage: 5.0,
    available: "0",
    frozen: true,
  },
};
