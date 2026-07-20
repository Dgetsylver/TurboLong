import "./select.css";
import { el } from "./el";

/** Option may be a bare string or a {value,label} pair. */
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  options: Array<string | SelectOption>;
  value?: string;
  onChange?: (value: string) => void;
  /** Fixed width (e.g. 120). Defaults to 100%. */
  width?: number | string;
  /** Mono font. @default true */
  mono?: boolean;
  disabled?: boolean;
  id?: string;
  title?: string;
}

/** Styled native <select> — brand chevron + mono type. Options are strings or {value,label}. */
export function Select(props: SelectProps): HTMLSelectElement {
  const { options = [], value, onChange, width, mono = true, disabled = false, id, title } = props;

  const opts: SelectOption[] = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));

  const cls = ["tl-select", mono ? "tl-select--mono" : "tl-select--sans"].join(" ");

  const sel = el(
    "select",
    { class: cls, ...(id ? { id } : {}), ...(title ? { title } : {}) },
    opts.map((o) => el("option", { value: o.value, ...(o.value === value ? { selected: "" } : {}) }, [o.label])),
  ) as HTMLSelectElement;

  if (width != null) sel.style.width = typeof width === "number" ? `${width}px` : width;
  if (value != null) sel.value = value;
  sel.disabled = disabled;

  if (onChange) {
    sel.addEventListener("change", () => onChange(sel.value));
  }

  return sel;
}
