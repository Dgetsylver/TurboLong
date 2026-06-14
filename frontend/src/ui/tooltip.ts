import "./tooltip.css";
import { el, type Child } from "./el";

export interface TooltipProps {
  /** Explanation text shown in the popover. */
  text: Child;
  /** Custom trigger. Omit to render the default "?" circle. */
  children?: Child | Child[];
  /** Popover side. @default "top" */
  placement?: "top" | "bottom";
  /** Optional class on the wrapper span. */
  class?: string;
  /** Optional id on the wrapper span. */
  id?: string;
}

/**
 * The small "?" info mark that explains jargon inline (Health Factor, c_factor,
 * utilization…). Reveals a short plain-language popover on hover/focus. Default
 * trigger is the "?" circle; pass children to wrap a custom trigger.
 */
export function Tooltip(props: TooltipProps): HTMLSpanElement {
  const { text, children, placement = "top", class: className, id } = props;

  const ariaLabel = typeof text === "string" ? text : "More info";

  const trigger: Child[] =
    children != null && children !== false
      ? Array.isArray(children)
        ? children
        : [children]
      : [
          el(
            "span",
            {
              class: "tl-tip__mark",
              tabindex: "0",
              role: "button",
              "aria-label": ariaLabel,
            },
            ["?"],
          ),
        ];

  const pop = el(
    "span",
    { class: `tl-tip__pop tl-tip__pop--${placement}`, role: "tooltip" },
    [text],
  );

  const cls = ["tl-tip", className].filter(Boolean).join(" ");

  return el(
    "span",
    { class: cls, ...(id ? { id } : {}) },
    [...trigger, pop],
  ) as HTMLSpanElement;
}
