import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { moveMenuIndex } from "../../menuNavigation";
import { useAnchoredPosition } from "./useAnchoredPosition";

export interface MenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  className?: string;
  children: ReactNode;
}

function menuItems(root: HTMLElement | null) {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled]):not([aria-disabled='true'])"),
  );
}

/** Accessible action menu: arrow keys / Home / End navigate, Escape closes and restores focus to the anchor. */
export function Menu(props: MenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(props.anchorRef, menu, props.open);
  const { open, onClose, anchorRef } = props;

  useEffect(() => {
    if (!open) return;
    menuItems(menu.current)[0]?.focus({ preventScroll: true });
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [anchorRef, onClose, open]);

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
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (next === -2) return;
    event.preventDefault();
    items[next]?.focus();
  };

  if (!open) return null;
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={props.label}
      className={`ui-menu ${props.className ?? ""}`.trim()}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        const item = (event.target as HTMLElement).closest("[role='menuitem']");
        if (item && !item.hasAttribute("disabled")) close();
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

export type MenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role"> & {
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
