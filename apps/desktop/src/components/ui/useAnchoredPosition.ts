import { useLayoutEffect, useState, type RefObject } from "react";
import { menuPosition } from "../../menuPosition";

export interface AnchoredPosition {
  left: number;
  top: number;
  maxHeight: number;
}

/** Position a floating element next to its anchor, flipping above when needed. */
export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  open: boolean,
  /** Viewport point (e.g. a context-menu click) used instead of the anchor's rect. */
  point?: { x: number; y: number } | null,
): AnchoredPosition | null {
  const pointX = point?.x;
  const pointY = point?.y;
  const [position, setPosition] = useState<AnchoredPosition | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = () => {
      const anchor = anchorRef.current;
      const floating = floatingRef.current;
      if (!floating || (!anchor && pointX === undefined)) return;
      const trigger =
        pointX !== undefined && pointY !== undefined
          ? { left: pointX, top: pointY, bottom: pointY }
          : anchor!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      // Layout dimensions exclude the pop-in animation's scale/translation.
      const next = menuPosition(
        {
          left: trigger.left - left,
          top: trigger.top - top,
          bottom: trigger.bottom - top,
        },
        {
          width: floating.offsetWidth,
          height: Math.max(floating.offsetHeight, floating.scrollHeight),
        },
        {
          width: viewport?.width ?? window.innerWidth,
          height: viewport?.height ?? window.innerHeight,
        },
      );
      setPosition({ ...next, left: next.left + left, top: next.top + top });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (floatingRef.current) observer?.observe(floatingRef.current);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [anchorRef, floatingRef, open, pointX, pointY]);
  return position;
}
