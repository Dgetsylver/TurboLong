import "./modal.css";
import { el, type Child } from "./el";

export interface ModalProps {
  /** Whether the modal is shown. When false the builder returns `null`. */
  open: boolean;
  /** Close handler (Esc, backdrop, ✕). Omit the ✕ by omitting this. */
  onClose?: () => void;
  title?: Child | Child[];
  /** Optional leading glyph/emoji next to the title. */
  icon?: Child | Child[];
  /** Footer action row (e.g. Cancel + Confirm buttons). */
  footer?: Child | Child[];
  /** Max width in px. @default 480 */
  width?: number;
  /** Allow backdrop click to close. @default true */
  closeOnBackdrop?: boolean;
  /** Optional id on the dialog card. */
  id?: string;
  children?: Child | Child[];
}

const kids = (c: Child | Child[] | undefined): Child[] =>
  c == null ? [] : Array.isArray(c) ? c : [c];

/** Centered dialog over a blurred scrim. Closes on Esc / backdrop / ✕. */
export function Modal(props: ModalProps): HTMLElement | null {
  const {
    open,
    onClose,
    title,
    icon,
    footer,
    width = 480,
    closeOnBackdrop = true,
    id,
    children,
  } = props;

  if (!open) return null;

  // ── Header (rendered when there's a title or a close affordance) ──
  const head =
    title != null || onClose
      ? el("div", { class: "tl-modal__head" }, [
          el("div", { class: "tl-modal__heading" }, [
            icon != null
              ? el("span", { class: "tl-modal__icon", "aria-hidden": "true" }, kids(icon))
              : null,
            title != null
              ? el("h2", { class: "tl-modal__title" }, kids(title))
              : null,
          ]),
          onClose
            ? (() => {
                const x = el(
                  "button",
                  { class: "tl-modal__close", type: "button", "aria-label": "Close" },
                  ["✕"],
                );
                x.addEventListener("click", onClose);
                return x;
              })()
            : null,
        ])
      : null;

  const body = el("div", { class: "tl-modal__body" }, kids(children));

  const foot =
    footer != null ? el("div", { class: "tl-modal__footer" }, kids(footer)) : null;

  // ── Dialog card ──
  const card = el(
    "div",
    {
      class: "tl-modal__card",
      role: "dialog",
      "aria-modal": "true",
      style: `max-width:${width}px`,
      ...(id ? { id } : {}),
    },
    [head, body, foot],
  );
  // Clicks inside the card never reach the backdrop.
  card.addEventListener("click", (e) => e.stopPropagation());

  // ── Backdrop scrim ──
  const overlay = el("div", { class: "tl-modal" }, [card]);
  if (closeOnBackdrop && onClose) {
    overlay.addEventListener("click", () => onClose());
  }

  // ── Esc to close — listener tied to the element's lifecycle ──
  if (onClose) {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Detach when the overlay leaves the DOM (best-effort cleanup).
    const obs = new MutationObserver(() => {
      if (!overlay.isConnected) {
        document.removeEventListener("keydown", onKey);
        obs.disconnect();
      }
    });
    if (overlay.ownerDocument?.body) {
      obs.observe(overlay.ownerDocument.body, { childList: true, subtree: true });
    }
  }

  return overlay;
}
