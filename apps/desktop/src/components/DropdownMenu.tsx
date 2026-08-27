import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

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
    setPos({ top: rect.top, left: rect.right + 4 });
  }, [triggerRef]);

  useLayoutEffect(() => {
    if (!open) return;
    recalc();
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

  return createPortal(
    <div
      ref={menuRef}
      className="dropdown-menu"
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 10000 }}
    >
      {children}
    </div>,
    document.body,
  );
}
