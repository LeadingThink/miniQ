import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { isMobileLayout } from "../mobileViewport";

type SessionPreviewProps = {
  children: ReactElement<{ "aria-describedby"?: string }>;
  title: string;
  preview?: string;
  contextLabel?: string;
  detail: string;
  disabled?: boolean;
};

export function SessionPreview({ children, title, preview, contextLabel, detail, disabled = false }: SessionPreviewProps) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const pointerFocus = useRef(false);
  const tooltip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 300 });
  const visible = open && !disabled;
  const clearTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);
  const leave = () => {
    clearTimer();
    if (!focused && !disabled) timer.current = setTimeout(close, 100);
  };

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      clearTimer();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [disabled, close, clearTimer]);

  useLayoutEffect(() => {
    if (!visible || !anchor.current || !tooltip.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const width = Math.max(0, Math.min(300, window.innerWidth - 16));
    // Set the final width before measuring wrapped content.
    tooltip.current.style.width = `${width}px`;
    const height = tooltip.current.getBoundingClientRect().height;
    const left = rect.right + 8 + width <= window.innerWidth - 8
      ? rect.right + 8
      : rect.left - width - 8;
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)),
      width,
    });
  }, [visible, title, preview, contextLabel, detail]);

  return (
    <>
      <div
        ref={anchor}
        className="session-preview-anchor"
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse" || disabled || isMobileLayout()) return;
          clearTimer();
          if (!open) timer.current = setTimeout(() => {
            if (!isMobileLayout()) setOpen(true);
          }, 400);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") leave();
        }}
        onPointerDownCapture={() => {
          // Pointer focus precedes click. A portal opened here can cover the
          // tapped row before WebView dispatches its click.
          pointerFocus.current = true;
          close();
        }}
        onKeyDownCapture={() => { pointerFocus.current = false; }}
        onFocusCapture={() => {
          if (disabled || pointerFocus.current || isMobileLayout()) return;
          setFocused(true);
          clearTimer();
          setOpen(true);
        }}
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          pointerFocus.current = false;
          setFocused(false);
          close();
        }}
        onClickCapture={close}
      >
        {cloneElement(children, {
          "aria-describedby": visible && focused
            ? [children.props["aria-describedby"], id].filter(Boolean).join(" ")
            : children.props["aria-describedby"],
        })}
      </div>
      {visible && createPortal(
        <div
          ref={tooltip}
          id={id}
          role="tooltip"
          className="session-hover-preview"
          style={{ position: "fixed", ...position, boxSizing: "border-box", maxHeight: "calc(100vh - 16px)", overflowY: "auto" }}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") clearTimer();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") leave();
          }}
        >
          <strong>{title}</strong>
          <small>{detail}</small>
          {contextLabel && <small>{contextLabel}</small>}
          {preview && <p>{preview}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}
