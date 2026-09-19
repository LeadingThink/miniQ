/** Fit the shell to the visible area above the keyboard, while leaving the
 * layout unchanged when the user deliberately zooms the page. */
export function initializeMobileViewport(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const update = () => {
    // A pinch also shrinks visualViewport.height. Relaying that shrink into
    // layout feeds the zoom back into itself and makes the UI jump in size.
    if (viewport && Math.abs((viewport.scale ?? 1) - 1) > 0.01) return;
    const layoutHeight = Math.max(
      1,
      document.documentElement.clientHeight || window.innerHeight,
    );
    const height = Math.max(1, Math.min(layoutHeight, viewport?.height ?? layoutHeight));
    root.style.setProperty("--app-height", `${height}px`);
    root.style.setProperty("--app-offset-top", `${Math.max(0, viewport?.offsetTop ?? 0)}px`);
  };
  update();
  window.addEventListener("resize", update, { passive: true });
  viewport?.addEventListener("resize", update, { passive: true });
  viewport?.addEventListener("scroll", update, { passive: true });
  return () => {
    window.removeEventListener("resize", update);
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
  };
}
export const MOBILE_LAYOUT_QUERY = "(max-width: 720px), (pointer: coarse) and (max-height: 520px)";

export function isMobileLayout(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_LAYOUT_QUERY).matches
    : window.innerWidth <= 720;
}
