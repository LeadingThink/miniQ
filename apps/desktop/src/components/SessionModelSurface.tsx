import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import "./SessionModelSurface.css";

/** Share the same model form; phones put it in the native modal top layer. */
export function SessionModelSurface(props: {
  mobile: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  placement?: "above" | "below";
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [desktopPosition, setDesktopPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (props.mobile) return;
    const updatePosition = () => {
      const bounds = props.trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(540, window.innerWidth - 32);
      setDesktopPosition({
        top: props.placement === "below" ? bounds.bottom + 10 : bounds.top - 10,
        left: Math.max(16, Math.min(bounds.left, window.innerWidth - width - 16)),
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
