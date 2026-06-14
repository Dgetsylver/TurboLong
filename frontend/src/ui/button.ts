import "./button.css";
import { el, type Child } from "./el";

export interface ButtonProps {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  fullWidth?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  id?: string;
  onClick?: (e: MouseEvent) => void;
  children?: Child | Child[];
}

/** Primary action primitive. Mint-gradient primary, signal-red danger, secondary/ghost. */
export function Button(props: ButtonProps = {}): HTMLButtonElement {
  const {
    variant = "primary",
    size = "md",
    loading = false,
    fullWidth = false,
    disabled = false,
    type = "button",
    title,
    id,
    onClick,
    children,
  } = props;

  const cls = [
    "tl-btn",
    `tl-btn--${variant}`,
    `tl-btn--${size}`,
    fullWidth ? "tl-btn--full" : "",
    loading ? "is-loading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const kids: Child[] = loading ? [el("span", { class: "tl-btn__spin", "aria-hidden": "true" })] : [];
  const content = Array.isArray(children) ? children : [children];
  kids.push(...content);

  const btn = el("button", { class: cls, type, ...(title ? { title } : {}), ...(id ? { id } : {}) }, kids) as HTMLButtonElement;
  btn.disabled = disabled || loading;
  if (onClick) btn.addEventListener("click", onClick);
  return btn;
}
