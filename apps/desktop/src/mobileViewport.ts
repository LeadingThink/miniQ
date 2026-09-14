/** Keep layout height stable while iOS keyboard/browser chrome changes the
 * visual viewport. The shell uses the layout viewport; the keyboard inset is
 * available to controls that need to avoid the keyboard. */
export function initializeMobileViewport(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }
  const root = document.documentElement;
  const update = () => {
    // clientHeight is the layout viewport in WebKit; jsdom and older engines
    // may report zero, so retain innerHeight as a fallback.
    const layoutHeight = Math.max(
      1,
      document.documentElement.clientHeight || window.innerHeight,
    );
    const visualHeight = Math.max(1, window.visualViewport?.height ?? layoutHeight);
    root.style.setProperty("--app-height", `${layoutHeight}px`);
    root.style.setProperty(
      "--keyboard-inset",
      `${Math.max(0, layoutHeight - visualHeight)}px`,
    );
  };
  update();
  window.addEventListener("resize", update, { passive: true });
  window.visualViewport?.addEventListener("resize", update, { passive: true });
  window.visualViewport?.addEventListener("scroll", update, { passive: true });
  return () => {
    window.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("scroll", update);
  };
}
