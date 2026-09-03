import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface DropdownMenuProps {
  triggerRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function DropdownMenu({
  triggerRef,
  open,
  onClose,
  children,
}: DropdownMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  const recalc = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth ?? 140;
    const menuHeight = menuRef.current?.offsetHeight ?? 180;
    const left = Math.max(8, Math.min(rect.right + 4, window.innerWidth - menuWidth - 8));
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - menuHeight - 8));
    setPos({ top, left });
  }, [triggerRef]);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    recalc();
    window.requestAnimationFrame(() => {
      recalc();
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
  }, [open, recalc]);

  useEffect(() => {
    if (!open) return;
    const handleScroll = () => recalc();
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", recalc);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", recalc);
    };
  }, [open, recalc]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1 + buttons.length) % buttons.length;
    else if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
      return;
    } else return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="dropdown-menu"
      role="menu"
      onKeyDown={handleKeyDown}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 10000 }}
    >
      {Children.map(children, (child) =>
        isValidElement(child)
          ? cloneElement(child as ReactElement<{ role?: string; type?: "button" }>, {
              role: "menuitem",
              type: "button",
            })
          : child,
      )}
    </div>,
    document.body,
  );
}
