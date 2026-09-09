import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  Hand,
  SquareCheck,
  CircleAlert,
  ChevronDown,
  Check,
  type LucideIcon,
} from "lucide-react";
import { moveMenuIndex } from "../menuNavigation";
import { menuPosition } from "../menuPosition";
import type { ApprovalMode } from "../types";

const MODE_LABELS: Record<
  ApprovalMode,
  { label: string; icon: LucideIcon; desc: string }
> = {
  alwaysAsk: {
    label: "请求批准",
    icon: Hand,
    desc: "修改文件和使用网络等操作每次都询问",
  },
  auto: {
    label: "替我审批",
    icon: SquareCheck,
    desc: "常规操作自动执行,联网访问和危险命令等高风险操作才询问",
  },
  fullAccess: {
    label: "完全访问",
    icon: CircleAlert,
    desc: "非阻止操作直接执行;确需选择时询问,3分钟无回复自动继续",
  },
};

const MODES = Object.keys(MODE_LABELS) as ApprovalMode[];

export function ApprovalModeSelect(props: {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});

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
    props.onChange(mode);
  };

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!triggerRef.current || !menuRef.current) return;
      setPosition(
        menuPosition(
          triggerRef.current.getBoundingClientRect(),
          {
            width: menuRef.current.getBoundingClientRect().width,
            height: menuRef.current.scrollHeight,
          },
          {
            width: window.innerWidth,
            height: window.visualViewport?.height ?? window.innerHeight,
          },
        ),
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
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
        disabled={props.disabled}
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
        <CurrentIcon className="mode-icon" />
        {current.label}
        <ChevronDown className="mode-caret" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={position}
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
                    <Icon className="mode-icon" />
                    {MODE_LABELS[mode].label}
                    {mode === props.mode && <Check className="mode-check" />}
                  </div>
                  <div className="mode-item-desc">{MODE_LABELS[mode].desc}</div>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
