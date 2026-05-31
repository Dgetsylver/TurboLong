import type { Meta, StoryObj } from "@storybook/html";

interface Asset {
  symbol: string;
  name: string;
  balance?: string;
}

interface AssetPickerArgs {
  assets: Asset[];
  selectedIndex: number;
  showBalances: boolean;
}

function renderAssetPicker(args: AssetPickerArgs): HTMLElement {
  const { assets, selectedIndex, showBalances } = args;
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:360px;";

  const bar = document.createElement("div");
  bar.className = "asset-tabs-bar";
  bar.style.cssText = `
    background:var(--color-surface,#161b22);
    border:1px solid var(--color-border,#21262d);
    border-radius:8px;
    padding:4px;
    display:flex;
    gap:4px;
  `;

  assets.forEach((asset, i) => {
    const btn = document.createElement("button");
    btn.role = "tab";
    btn.setAttribute("aria-selected", String(i === selectedIndex));
    btn.style.cssText = `
      flex:1;
      padding:8px 4px;
      border:none;
      border-radius:6px;
      cursor:pointer;
      font-family:inherit;
      font-size:13px;
      background:${i === selectedIndex ? "var(--color-accent,#1f6feb)" : "transparent"};
      color:${i === selectedIndex ? "#ffffff" : "var(--color-text-muted,#8b949e)"};
      font-weight:${i === selectedIndex ? "600" : "400"};
      transition:background 0.15s;
    `;

    const label = document.createElement("div");
    label.textContent = asset.symbol;

    if (showBalances && asset.balance) {
      const bal = document.createElement("div");
      bal.style.cssText = "font-size:10px;margin-top:2px;opacity:0.8;";
      bal.textContent = asset.balance;
      btn.appendChild(label);
      btn.appendChild(bal);
    } else {
      btn.appendChild(label);
    }

    btn.addEventListener("click", () => {
      bar.querySelectorAll("button").forEach((b, j) => {
        const isSelected = j === i;
        b.setAttribute("aria-selected", String(isSelected));
        (b as HTMLElement).style.background = isSelected
          ? "var(--color-accent,#1f6feb)"
          : "transparent";
        (b as HTMLElement).style.color = isSelected
          ? "#ffffff"
          : "var(--color-text-muted,#8b949e)";
        (b as HTMLElement).style.fontWeight = isSelected ? "600" : "400";
      });
    });

    bar.appendChild(btn);
  });

  wrap.appendChild(bar);
  return wrap;
}

const meta: Meta<AssetPickerArgs> = {
  title: "Components/Asset Picker",
  tags: ["autodocs"],
  render: (args) => renderAssetPicker(args),
  argTypes: {
    selectedIndex: { control: { type: "number", min: 0 } },
    showBalances:  { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<AssetPickerArgs>;

export const Etherfuse: Story = {
  args: {
    assets: [
      { symbol: "USDC", name: "USD Coin",    balance: "1,240.00" },
      { symbol: "XLM",  name: "Lumen",       balance: "5,000.00" },
      { symbol: "CETES",name: "CETES Token", balance: "320.50" },
    ],
    selectedIndex: 2,
    showBalances: true,
  },
};

export const MultiAsset: Story = {
  args: {
    assets: [
      { symbol: "USDC", name: "USD Coin" },
      { symbol: "wETH", name: "Wrapped Ether" },
      { symbol: "wBTC", name: "Wrapped Bitcoin" },
      { symbol: "XLM",  name: "Lumen" },
    ],
    selectedIndex: 0,
    showBalances: false,
  },
};
