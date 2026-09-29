import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** Places a fixed popover above (or below) the enclosing `.composer-card`. */
export function useComposerPopoverPosition(menuRef: RefObject<HTMLElement | null>): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const place = () => {
      const composer = menuRef.current?.closest(".composer-card");
      if (!composer) return;
      const bounds = composer.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const above = bounds.top - top - 8;
      const below = top + height - bounds.bottom - 8;
      const placeAbove = above >= below;
      const maxHeight = Math.min(420, Math.max(100, placeAbove ? above - 8 : below - 8));
      setPosition({
        left: Math.max(8, Math.min(bounds.left, width - bounds.width - 8)),
        width: Math.min(bounds.width, width - 16),
        maxHeight,
        top: placeAbove ? bounds.top - 8 : bounds.bottom + 8,
        transform: placeAbove ? "translateY(-100%)" : undefined,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [menuRef]);
  return position;
}
