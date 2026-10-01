import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute("inert") && element.getAttribute("aria-hidden") !== "true",
  );
}

export interface FocusTrapOptions {
  /** Restore focus to the previously focused element when the trap deactivates. Default true. */
  restoreFocus?: boolean;
  /** Move focus into the container on activation. Default true. */
  autoFocus?: boolean;
}

/**
 * Keep keyboard focus inside `ref` while `active`. Focus moves to the first
 * `[data-autofocus]` element (or the first focusable one) on activation and
 * returns to the previously focused element on deactivation.
 */
export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  options: FocusTrapOptions = {},
) {
  const restoreFocus = options.restoreFocus ?? true;
  const autoFocus = options.autoFocus ?? true;
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    previous.current = document.activeElement;

    if (autoFocus && !container.contains(document.activeElement)) {
      const preferred = container.querySelector<HTMLElement>("[data-autofocus]");
      const target = preferred ?? focusableElements(container)[0] ?? container;
      if (target === container && !container.hasAttribute("tabindex")) {
        container.setAttribute("tabindex", "-1");
      }
      target.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusableElements(container);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const target = previous.current;
      if (restoreFocus && target instanceof HTMLElement && target.isConnected) {
        target.focus({ preventScroll: true });
      }
    };
  }, [active, autoFocus, ref, restoreFocus]);
}
