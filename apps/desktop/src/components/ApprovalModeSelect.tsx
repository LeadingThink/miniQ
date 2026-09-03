import { useEffect, useId, useRef, useState } from "react";
import { moveMenuIndex } from "../menuNavigation";
import type { ApprovalMode } from "../types";

function HandIcon() {
  return (
    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11m0-5.5v-1a1.5 1.5 0 0 0-3 0V11m0-6.5a1.5 1.5 0 0 0-3 0V12m-3-4a1.5 1.5 0 0 1 3 0v6l-1.8-1.2a1.6 1.6 0 0 0-2 2.5l4.3 4.7a5 5 0 0 0 3.7 1.6h1.9a5 5 0 0 0 5-5V11" />
    </svg>
  );
}

function ApproveIcon() {
  return (
    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7.5 12 3 3 6-6" />
    </svg>
  );
}

function FullAccessIcon() {
  return (
    <svg className="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13" />
      <circle cx="12" cy="16.5" r="0.4" fill="currentColor" />
    </svg>
  );
}

const MODE_LABELS: Record<
  ApprovalMode,
  { label: string; icon: () => JSX.Element; desc: string }
> = {
  alwaysAsk: {
    label: "请求批准",
    icon: HandIcon,
    desc: "修改文件和使用网络等操作每次都询问",
  },
  auto: {
    label: "替我审批",
    icon: ApproveIcon,
    desc: "常规操作自动执行,联网访问和危险命令等高风险操作才询问",
  },
  fullAccess: {
    label: "完全访问",
    icon: FullAccessIcon,
    desc: "非阻止操作直接执行;确需选择时询问,3分钟无回复自动继续",
  },
};

const MODES = Object.keys(MODE_LABELS) as ApprovalMode[];

export function ApprovalModeSelect(props: {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = (index = MODES.indexOf(props.mode)) => {
    setActiveIndex(Math.max(0, index));
    setOpen(true);
  };

  const selectMode = (mode: ApprovalMode) => {
    close(true);
    if (mode !== props.mode) props.onChange(mode);
  };

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  const current = MODE_LABELS[props.mode] ?? MODE_LABELS.auto;
  const CurrentIcon = current.icon;
  return (
    <div className="mode-select" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className={`mode-trigger ${props.mode === "fullAccess" ? "warn" : ""}`}
        title={current.desc}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(
              moveMenuIndex(
                MODES.indexOf(props.mode),
                MODES.length,
                event.key === "ArrowDown" ? 1 : -1,
              ),
            );
          }
        }}
      >
        <CurrentIcon />
        {current.label}
        <svg className="mode-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id={menuId}
          className="mode-menu"
          role="listbox"
          aria-label="执行权限"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) =>
                moveMenuIndex(
                  index,
                  MODES.length,
                  event.key === "ArrowDown" ? 1 : -1,
                ),
              );
            }
          }}
        >
          {MODES.map((mode, index) => {
            const Icon = MODE_LABELS[mode].icon;
            return (
              <button
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                key={mode}
                type="button"
                role="option"
                aria-selected={mode === props.mode}
                className={`mode-item ${mode === props.mode ? "active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectMode(mode)}
              >
                <div className="mode-item-label">
                  <Icon />
                  {MODE_LABELS[mode].label}
                  {mode === props.mode && (
                    <svg className="mode-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  )}
                </div>
                <div className="mode-item-desc">{MODE_LABELS[mode].desc}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
