import type { Meta, StoryObj } from "@storybook/html";

type ToastType = "info" | "success" | "error";

interface ToastArgs {
  message: string;
  type: ToastType;
  txHash?: string;
}

function renderToast({ message, type, txHash }: ToastArgs): string {
  const icon   = type === "success" ? "✓" : type === "error" ? "✗" : "⟳";
  const colors: Record<ToastType, string> = {
    success: "#2ea043",
    error:   "#f85149",
    info:    "#388bfd",
  };
  const bg: Record<ToastType, string> = {
    success: "rgba(46,160,67,0.12)",
    error:   "rgba(248,81,73,0.12)",
    info:    "rgba(56,139,253,0.12)",
  };

  const linkHtml = txHash
    ? `<a style="color:${colors[type]};font-size:12px;margin-left:auto;white-space:nowrap;" href="#" onclick="return false">View →</a>`
    : "";

  return `
    <div class="toast toast-${type}" style="
      display:flex;
      align-items:center;
      gap:10px;
      padding:10px 14px;
      border-radius:8px;
      border:1px solid ${colors[type]};
      background:${bg[type]};
      font-size:13px;
      color:var(--color-text,#e6edf3);
      min-width:280px;
      max-width:400px;
      box-shadow:0 4px 12px rgba(0,0,0,0.3);
    " role="alert">
      <span style="color:${colors[type]};font-weight:700;font-size:15px;">${icon}</span>
      <span style="flex:1;">${message}</span>
      ${linkHtml}
    </div>
  `;
}

function renderToastStack(count: number): string {
  const toasts = [
    { message: "Position opened successfully!", type: "success" as ToastType, txHash: "abc123" },
    { message: "Fetching latest pool data…",    type: "info"    as ToastType },
    { message: "Transaction failed: fee too low", type: "error" as ToastType },
  ].slice(0, count);

  return `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${toasts.map(renderToast).join("")}
    </div>
  `;
}

const meta: Meta<ToastArgs> = {
  title: "Components/Toast",
  tags: ["autodocs"],
  render: (args) => renderToast(args),
  argTypes: {
    type:    { control: { type: "select" }, options: ["info", "success", "error"] },
    message: { control: "text" },
    txHash:  { control: "text" },
  },
};

export default meta;
type Story = StoryObj<ToastArgs>;

export const Success: Story = {
  args: {
    type: "success",
    message: "Position opened successfully!",
    txHash: "a1b2c3d4e5f6",
  },
};

export const Info: Story = {
  args: {
    type: "info",
    message: "Switched to Testnet. Please also switch your wallet.",
  },
};

export const Error: Story = {
  args: {
    type: "error",
    message: "Transaction failed: insufficient balance.",
  },
};

export const Stack: StoryObj = {
  render: () => renderToastStack(3),
};
