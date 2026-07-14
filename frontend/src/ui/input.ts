import "./input.css";
import { el, type Child } from "./el";

export interface InputProps {
  /** Trailing unit label, rendered in mono (e.g. "USDC"). */
  suffix?: Child;
  /** Show a Max chip and call this when tapped. Omit to hide. */
  onMax?: () => void;
  /** Initial value of the field. */
  value?: string;
  /** Placeholder text. */
  placeholder?: string;
  /** Mobile keyboard hint (e.g. "decimal"). */
  inputMode?: "text" | "decimal" | "numeric" | "tel" | "email" | "url" | "search" | "none";
  /** Native input type. */
  type?: string;
  /** Disable the field. */
  disabled?: boolean;
  /** name attribute (for forms). */
  name?: string;
  /** id attribute (for label association). */
  id?: string;
  /** Accessible title / tooltip. */
  title?: string;
  /** Fired on every value change. */
  onChange?: (value: string, e: Event) => void;
  /** Fired on focus. */
  onFocus?: (e: FocusEvent) => void;
  /** Fired on blur. */
  onBlur?: (e: FocusEvent) => void;
}

/**
 * Turbolong Input — amount field with an optional mono suffix (asset symbol) and
 * a Max chip. Mono text; focus draws the mint ring. Use for deposit / amount entry.
 */
export function Input(props: InputProps = {}): HTMLElement {
  const {
    suffix,
    onMax,
    value,
    placeholder,
    inputMode,
    type = "text",
    disabled = false,
    name,
    id,
    title,
    onChange,
    onFocus,
    onBlur,
  } = props;

  const inputCls = ["tl-input__field", suffix ? "tl-input__field--suffix" : "", onMax ? "tl-input__field--max" : ""]
    .filter(Boolean)
    .join(" ");

  const input = el("input", {
    class: inputCls,
    type,
    ...(value != null ? { value } : {}),
    ...(placeholder != null ? { placeholder } : {}),
    ...(inputMode ? { inputmode: inputMode } : {}),
    ...(name ? { name } : {}),
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
  }) as HTMLInputElement;
  input.disabled = disabled;

  if (onChange) input.addEventListener("input", (e) => onChange(input.value, e));
  if (onFocus) input.addEventListener("focus", (e) => onFocus(e as FocusEvent));
  if (onBlur) input.addEventListener("blur", (e) => onBlur(e as FocusEvent));

  const kids: Child[] = [input];

  if (onMax) {
    const chip = el(
      "button",
      {
        class: ["tl-input__max", suffix ? "tl-input__max--suffix" : ""].filter(Boolean).join(" "),
        type: "button",
      },
      ["Max"],
    ) as HTMLButtonElement;
    chip.addEventListener("click", onMax);
    kids.push(chip);
  }

  if (suffix) {
    kids.push(el("span", { class: "tl-input__suffix" }, [suffix]));
  }

  return el("div", { class: "tl-input" }, kids);
}
