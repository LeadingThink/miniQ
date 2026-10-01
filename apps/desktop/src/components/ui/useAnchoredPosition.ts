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
      const box = floating.getBoundingClientRect();
      setPosition(
        menuPosition(
          { left: trigger.left, top: trigger.top, bottom: trigger.bottom },
          { width: box.width, height: box.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, floatingRef, open, pointX, pointY]);
  return position;
}
