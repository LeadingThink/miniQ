import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import "./SessionModelSurface.css";

export function modelPickerRightBoundary(margin = 16): number {
  const browserLeft = Array.from(document.querySelectorAll<HTMLElement>(".browser-panel:not(.browser-panel-inactive) .browser-surface"))
    .map((surface) => surface.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .reduce((left, rect) => Math.min(left, rect.left), window.innerWidth);
  return Math.max(margin + 1, Math.min(window.innerWidth - margin, browserLeft - margin));
}

/** Share the same model form; phones put it in the native modal top layer. */
export function SessionModelSurface(props: {
  mobile: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  placement?: "above" | "below";
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [desktopPosition, setDesktopPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (props.mobile) return;
    const updatePosition = () => {
      const bounds = props.trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const right = modelPickerRightBoundary();
      const width = Math.max(1, Math.min(540, right - 16));
      setDesktopPosition({
        top: props.placement === "below" ? bounds.bottom + 10 : bounds.top - 10,
        left: Math.max(16, Math.min(bounds.left, right - width)),
        width,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.mobile, props.placement, props.trigger]);
  useEffect(() => {
    if (!props.mobile) return;
    const element = dialog.current!;
    element.showModal();
    element.focus({ preventScroll: true });
    const trigger = props.trigger.current;
    return () => {
      element.close();
      trigger?.focus({ preventScroll: true });
    };
  }, [props.mobile, props.trigger]);
  if (!props.mobile) {
    if (!desktopPosition) return null;
    return createPortal(
      <div
        className="session-model-surface-portal"
        style={{
          top: desktopPosition.top,
          left: desktopPosition.left,
          width: desktopPosition.width,
          transform: props.placement === "below" ? undefined : "translateY(-100%) translateY(-10px)",
        }}
      >
        {props.children}
      </div>,
      document.body,
    );
  }
  return createPortal(<dialog ref={dialog} className="session-model-dialog" aria-label="选择会话模型" tabIndex={-1}
    onCancel={(event) => { event.preventDefault(); props.onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) props.onClose();
    }}>
    {props.children}
  </dialog>, document.body);
}
