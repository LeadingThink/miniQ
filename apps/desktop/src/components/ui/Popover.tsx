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
  viewportGap?: number;
  /** Native dialog top layer; also suspends embedded child WebViews. */
  topLayer?: boolean;
  children: ReactNode;
}

/** Non-modal floating panel anchored to a trigger. Escape / outside click closes; focus returns to the anchor. */
export function Popover(props: PopoverProps) {
  const panel = useRef<HTMLDivElement & HTMLDialogElement>(null);
  const position = useAnchoredPosition(props.anchorRef, panel, props.open, null, props.viewportGap);
  const positioned = position !== null;
  const { open, onClose, anchorRef } = props;

  useEffect(() => {
    if (!open || !props.topLayer) return;
    const element = panel.current!;
    element.showModal();
    const trigger = anchorRef.current;
    return () => {
      element.close();
      trigger?.focus({ preventScroll: true });
    };
  }, [anchorRef, open, props.topLayer]);

  useEffect(() => {
    if (!open || !positioned) return;
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
  }, [anchorRef, onClose, open, positioned]);

  if (!open) return null;
  const Surface = props.topLayer ? "dialog" : "div";
  return createPortal(
    <Surface
      ref={panel}
      className={`ui-popover ${props.className ?? ""}`.trim()}
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      onClick={(event) => {
        if (!props.topLayer || event.target !== event.currentTarget) return;
        // A modal dialog retargets backdrop clicks to the dialog itself.
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
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
    </Surface>,
    document.body,
  );
}
