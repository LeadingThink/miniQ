import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronRight } from "lucide-react";
import { createPortal } from "react-dom";
import { moveMenuIndex } from "../../menuNavigation";
import { useAnchoredPosition } from "./useAnchoredPosition";

export interface MenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  className?: string;
  /** Open at a viewport point (context menus); focus still returns to the anchor. */
  point?: { x: number; y: number } | null;
  placement?: "right";
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}

const MenuFamily = createContext<string | null>(null);

function menuItems(root: HTMLElement | null) {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled]):not([aria-disabled='true'])"),
  );
}

/** Accessible action menu: arrow keys / Home / End navigate, Escape closes and restores focus to the anchor. */
export function Menu(props: MenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const family = useContext(MenuFamily) ?? id;
  const position = useAnchoredPosition(props.anchorRef, menu, props.open, props.point, undefined, props.placement);
  const { open, onClose, anchorRef } = props;

  useEffect(() => {
    if (!open) return;
    menuItems(menu.current)[0]?.focus({ preventScroll: true });
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || anchorRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest<HTMLElement>("[data-menu-family]")?.dataset.menuFamily === family) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [anchorRef, family, onClose, open]);

  const close = () => {
    onClose();
    anchorRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menu.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = -2;
    if (event.key === "ArrowDown") next = moveMenuIndex(current, items.length, 1);
    else if (event.key === "ArrowUp") next = moveMenuIndex(current, items.length, -1);
    else if (event.key === "Home") next = items.length ? 0 : -1;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape" || event.key === "Tab" || (props.placement === "right" && event.key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (next === -2) return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  };

  if (!open) return null;
  return createPortal(
    <MenuFamily.Provider value={family}><div
      ref={menu}
      role="menu"
      aria-label={props.label}
      data-menu-family={family}
      className={`ui-menu ${props.className ?? ""}`.trim()}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
      onKeyDown={onKeyDown}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        const item = (event.target as HTMLElement).closest("[role='menuitem']");
        if (item && !item.hasAttribute("disabled") && item.getAttribute("aria-haspopup") !== "menu") close();
      }}
    >
      {props.children}
    </div></MenuFamily.Provider>,
    document.body,
  );
}

export type MenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role"> & {
  ref?: RefObject<HTMLButtonElement | null>;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
};

export function MenuItem({ icon, shortcut, danger, className, children, type, ...rest }: MenuItemProps) {
  return (
    <button
      type={type ?? "button"}
      role="menuitem"
      tabIndex={-1}
      className={`ui-menu-item ${danger ? "ui-menu-item--danger" : ""} ${className ?? ""}`.trim()}
      {...rest}
    >
      {icon && <span className="ui-menu-item-icon" aria-hidden="true">{icon}</span>}
      <span className="ui-menu-item-label">{children}</span>
      {shortcut && <kbd className="ui-kbd">{shortcut}</kbd>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="ui-menu-separator" />;
}

/** Submenus share outside-click ownership with their parent portal. */
export function MenuSubmenu({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const enter = () => { clearTimeout(timer.current); setOpen(true); };
  const leave = () => { timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return <>
    <MenuItem ref={anchor} aria-haspopup="menu" aria-expanded={open} className="ui-menu-submenu-trigger"
      onMouseEnter={enter} onMouseLeave={leave} onClick={enter}
      onKeyDown={(event) => {
        if (["ArrowRight", "Enter", " "].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); enter();
        }
      }}>
      {label}<ChevronRight size={16} aria-hidden="true" />
    </MenuItem>
    <Menu open={open} anchorRef={anchor} placement="right" onClose={() => setOpen(false)} label={label}
      className={className} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}>
      {children}
    </Menu>
  </>;
}
