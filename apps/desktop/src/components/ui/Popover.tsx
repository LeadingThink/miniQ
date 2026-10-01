import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition } from "./useAnchoredPosition";
import { focusableElements } from "./useFocusTrap";

export interface PopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Accessible name for the popover region. */
  label: string;
  className?: string;
  children: ReactNode;
}

/** Non-modal floating panel anchored to a trigger. Escape / outside click closes; focus returns to the anchor. */
export function Popover(props: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(props.anchorRef, panel, props.open);
  const { open, onClose, anchorRef } = props;

  useEffect(() => {
    if (!open) return;
    const container = panel.current;
    if (container) {
      const preferred = container.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? focusableElements(container)[0] ?? container).focus({ preventScroll: true });
    }
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [anchorRef, onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      className={`ui-popover ${props.className ?? ""}`.trim()}
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          anchorRef.current?.focus();
        }
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
