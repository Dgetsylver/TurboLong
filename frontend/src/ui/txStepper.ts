import "./txStepper.css";
import { el, type Child } from "./el";

export interface TxStepperProps {
  /** Ordered step labels, e.g. ["Sign", "Submit", "Confirmed"]. */
  steps: string[];
  /** Index of the in-progress step. Equal to steps.length = all done. */
  current: number;
  /** Mark the current step failed. @default false */
  error?: boolean;
  /** Show a dismiss ✕ once finished or errored. */
  onClose?: () => void;
  id?: string;
  title?: string;
}

/**
 * Floating bottom-center transaction progress bar. Steps before `current` show
 * done (✓), `current` shows a spinner (or ✕ when `error`), the rest pending.
 * Returns null when there are no steps.
 */
export function TxStepper(props: TxStepperProps): HTMLElement | null {
  const { steps, current, error = false, onClose, id, title } = props;
  if (!steps.length) return null;

  const kids: Child[] = [];

  steps.forEach((label, i) => {
    const done = i < current;
    const active = i === current && !error;
    const err = i === current && error;

    if (i > 0) {
      const connFilled = i <= current;
      kids.push(
        el("span", {
          class: "tl-stepper__line" + (connFilled ? " is-filled" : ""),
          "aria-hidden": "true",
        }),
      );
    }

    const state = done ? "is-done" : err ? "is-error" : active ? "is-active" : "is-pending";

    const dotInner: Child = active
      ? el("span", { class: "tl-stepper__spin", "aria-hidden": "true" })
      : done
        ? "✓"
        : err
          ? "✕"
          : String(i + 1);

    const dot = el("span", { class: `tl-stepper__dot ${state}`, "aria-hidden": "true" }, [dotInner]);

    kids.push(el("span", { class: `tl-stepper__step ${state}` }, [dot, label]));
  });

  if (onClose && (current >= steps.length || error)) {
    const close = el(
      "button",
      {
        class: "tl-stepper__close",
        type: "button",
        "aria-label": "Dismiss",
      },
      ["✕"],
    );
    close.addEventListener("click", onClose);
    kids.push(close);
  }

  return el(
    "div",
    {
      class: "tl-stepper",
      role: "status",
      "aria-live": "polite",
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
    },
    kids,
  );
}
