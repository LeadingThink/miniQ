import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import "./SessionModelSurface.css";

/** Share the same model form; phones put it in the native modal top layer. */
export function SessionModelSurface(props: {
  mobile: boolean;
  trigger: RefObject<HTMLButtonElement>;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  if (!props.mobile) return props.children;
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
