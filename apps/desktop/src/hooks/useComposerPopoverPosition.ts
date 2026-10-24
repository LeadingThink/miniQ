import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/** Positions a body portal relative to the input's `.composer-card`. */
export function useComposerPopoverPosition(
  inputRef: RefObject<HTMLElement | null>,
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({
    visibility: "hidden",
  });
  useLayoutEffect(() => {
    let frame: number | null = null;
    const place = () => {
      const composer = inputRef.current?.closest(".composer-card");
      if (!composer) return;
      const bounds = composer.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const above = bounds.top - top - 8;
      const below = top + height - bounds.bottom - 8;
      const placeAbove = above >= below;
      const maxHeight = Math.min(
        420,
        Math.max(100, placeAbove ? above - 8 : below - 8),
      );
      const menuWidth = Math.max(0, Math.min(bounds.width, width - 16));
      const next: CSSProperties = {
        left: Math.max(
          left + 8,
          Math.min(bounds.left, left + width - menuWidth - 8),
        ),
        width: menuWidth,
        maxHeight,
        top: placeAbove ? bounds.top - 8 : bounds.bottom + 8,
        transform: placeAbove ? "translateY(-100%)" : undefined,
      };
      setPosition((current) =>
        Object.keys(next).every(
          (key) =>
            current[key as keyof CSSProperties] ===
            next[key as keyof CSSProperties],
        )
          ? current
          : next,
      );
    };
    const schedule = (event?: Event) => {
      // Scrolling a results list does not move the composer anchor.
      if (
        event?.type === "scroll" &&
        event.target instanceof Element &&
        !event.target.contains(inputRef.current)
      )
        return;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        place();
      });
    };
    place();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());
    const composer = inputRef.current?.closest(".composer-card");
    if (composer) observer?.observe(composer);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [inputRef]);
  return position;
}
