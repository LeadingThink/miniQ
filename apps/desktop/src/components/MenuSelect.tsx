import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { moveMenuIndex } from "../menuNavigation";
import { menuPosition } from "../menuPosition";

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  desc?: string;
}

/** Composer-style ghost trigger with a listbox popover, shared by toolbar pickers. */
export function MenuSelect<T extends string>(props: {
  value: T;
  options: MenuOption<T>[];
  onChange: (value: T) => void;
  menuLabel: string;
  title?: string;
  disabled?: boolean;
  tone?: "warn";
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const selectedIndex = props.options.findIndex(
    (option) => option.value === props.value,
  );

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = (index = selectedIndex) => {
    setActiveIndex(Math.max(0, index));
    setOpen(true);
  };

  const select = (value: T) => {
    close(true);
    props.onChange(value);
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

  const current = props.options[Math.max(0, selectedIndex)];
  const CurrentIcon = current.icon;
  const count = props.options.length;
  return (
    <div className="mode-select" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        disabled={props.disabled}
        className={`mode-trigger${props.tone ? ` ${props.tone}` : ""}`}
        title={props.title ?? current.desc}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(
              moveMenuIndex(
                selectedIndex,
                count,
                event.key === "ArrowDown" ? 1 : -1,
              ),
            );
          }
        }}
      >
        {CurrentIcon && <CurrentIcon className="mode-icon" />}
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
            aria-label={props.menuLabel}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close(true);
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) =>
                  moveMenuIndex(index, count, event.key === "ArrowDown" ? 1 : -1),
                );
              }
            }}
          >
            {props.options.map((option, index) => {
              const Icon = option.icon;
              const selected = option.value === props.value;
              return (
                <button
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`mode-item${selected ? " active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(option.value)}
                >
                  <div className="mode-item-label">
                    {Icon && <Icon className="mode-icon" />}
                    {option.label}
                    {selected && <Check className="mode-check" />}
                  </div>
                  {option.desc && (
                    <div className="mode-item-desc">{option.desc}</div>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
