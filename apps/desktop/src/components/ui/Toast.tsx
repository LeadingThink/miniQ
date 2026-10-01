import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export type ToastCloseReason = "timeout" | "action" | "dismiss";

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  message: ReactNode;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss. Default 5000. */
  duration?: number;
  tone?: "default" | "success" | "danger";
  /** Called exactly once when the toast leaves the screen. */
  onClose?: (reason: ToastCloseReason) => void;
}

export interface ToastApi {
  /** False when no ToastProvider is mounted; calls become no-ops. */
  available: boolean;
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

export const TOAST_DURATION = 5000;
const MAX_TOASTS = 4;

interface ToastRecord extends ToastOptions {
  id: string;
}

const ToastContext = createContext<ToastApi | null>(null);

let warned = false;
const NOOP_TOAST: ToastApi = {
  available: false,
  show: () => {
    if (import.meta.env.DEV && !warned) {
      warned = true;
      console.warn("[ui/Toast] useToast() called without a <ToastProvider>; toast ignored.");
    }
    return "";
  },
  dismiss: () => undefined,
};

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP_TOAST;
}

let nextToastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const records = useRef(new Map<string, ToastRecord>());

  const close = useCallback((id: string, reason: ToastCloseReason) => {
    const record = records.current.get(id);
    if (!record) return;
    records.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
    record.onClose?.(reason);
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const id = `toast-${++nextToastId}`;
      const record: ToastRecord = { ...options, id };
      records.current.set(id, record);
      const overflow = Array.from(records.current.keys()).slice(0, -MAX_TOASTS);
      for (const stale of overflow) close(stale, "dismiss");
      setToasts((current) => [...current.filter((toast) => records.current.has(toast.id)), record]);
      return id;
    },
    [close],
  );

  const dismiss = useCallback((id: string) => close(id, "dismiss"), [close]);

  // Settle pending callbacks (e.g. commit deferred deletes) if the provider unmounts.
  useEffect(() => {
    const pending = records.current;
    return () => {
      for (const record of Array.from(pending.values())) {
        pending.delete(record.id);
        record.onClose?.("dismiss");
      }
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ available: true, show, dismiss }), [dismiss, show]);

  const viewport = (
    <div className="ui-toast-viewport" aria-live="polite" aria-relevant="additions" role="region" aria-label="通知">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onClose={close} />
      ))}
    </div>
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document === "undefined" ? viewport : createPortal(viewport, document.body)}
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onClose,
}: {
  toast: ToastRecord;
  onClose: (id: string, reason: ToastCloseReason) => void;
}) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration ?? TOAST_DURATION);

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => onClose(toast.id, "timeout"), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [onClose, paused, toast.id]);

  return (
    <div
      className={`ui-toast ${toast.tone ? `tone-${toast.tone}` : ""}`.trim()}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <div className="ui-toast-message">{toast.message}</div>
      {toast.action && (
        <button
          type="button"
          className="ui-toast-action"
          onClick={() => {
            toast.action?.onAction();
            onClose(toast.id, "action");
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="ui-toast-close"
        aria-label="关闭通知"
        title="关闭通知"
        onClick={() => onClose(toast.id, "dismiss")}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

export interface UndoableOptions {
  /** Toast message, e.g. `已删除 “foo”`. */
  message: ReactNode;
  /** Commits the destructive operation. Runs when the toast times out or is dismissed. */
  onCommit: () => void | Promise<void>;
  /** Reverts the optimistic UI change. */
  onUndo: () => void;
  undoLabel?: string;
  duration?: number;
}

/**
 * Optimistic delete with undo: the caller hides the item first, then this
 * shows a toast with “撤销”. Undo restores; any other close commits. Without a
 * provider the operation commits immediately so behaviour never regresses.
 */
export function showUndoToast(toast: ToastApi, options: UndoableOptions) {
  if (!toast.available) {
    void options.onCommit();
    return "";
  }
  return toast.show({
    message: options.message,
    duration: options.duration,
    action: { label: options.undoLabel ?? "撤销", onAction: options.onUndo },
    onClose: (reason) => {
      if (reason !== "action") void options.onCommit();
    },
  });
}
