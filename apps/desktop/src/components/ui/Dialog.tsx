import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { useFocusTrap } from "./useFocusTrap";

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  /** alertdialog for destructive / high-risk confirmations. */
  role?: "dialog" | "alertdialog";
  className?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

/** Modal dialog with scrim, focus trap, Escape to close and focus restoration. */
export function Dialog(props: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(panel, props.open);
  if (!props.open) return null;
  const node = (
    <div
      className="ui-dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={panel}
        className={`ui-dialog ${props.className ?? ""}`.trim()}
        role={props.role ?? "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descriptionId : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
            props.onClose();
          }
        }}
      >
        <h2 id={titleId} className="ui-dialog-title">{props.title}</h2>
        {props.description && (
          <div id={descriptionId} className="ui-dialog-description">{props.description}</div>
        )}
        {props.children}
        {props.footer && <div className="ui-dialog-footer">{props.footer}</div>}
      </div>
    </div>
  );
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** In-app replacement for window.confirm. Cancel receives initial focus. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Dialog
      open={props.open}
      role="alertdialog"
      title={props.title}
      description={props.description}
      onClose={props.onCancel}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={props.onCancel}>
            {props.cancelLabel ?? "取消"}
          </Button>
          <Button
            variant={props.tone === "danger" ? "danger" : "primary"}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? "确认"}
          </Button>
        </>
      }
    />
  );
}
