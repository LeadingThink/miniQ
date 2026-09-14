import { Capacitor } from "@capacitor/core";

export function isNativeMobileApp(): boolean {
  return Capacitor.isNativePlatform();
}

export async function initializeMobileRuntime(): Promise<void> {
  if (!isNativeMobileApp()) return;
  document.documentElement.classList.add("native-mobile");
  // WKWebView can still apply a pinch gesture after the initial viewport has
  // been laid out (especially after focusing a form control).  That leaves
  // the whole app permanently magnified.  Native mobile uses the same fixed
  // scale as the desktop web shell; scrolling and text selection remain
  // available, while multi-touch zoom is ignored.
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) {
    viewport.content = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
  }
  const preventGestureZoom = (event: Event) => event.preventDefault();
  const preventPinch = (event: TouchEvent) => {
    if (
      event.touches.length > 1 &&
      !(event.target instanceof Element &&
        event.target.closest("[data-pinch-zoom]"))
    ) {
      event.preventDefault();
    }
  };
  document.addEventListener("gesturestart", preventGestureZoom, { passive: false });
  document.addEventListener("gesturechange", preventGestureZoom, { passive: false });
  document.addEventListener("gestureend", preventGestureZoom, { passive: false });
  document.addEventListener("touchmove", preventPinch, { passive: false });
  const { StatusBar, Style } = await import("@capacitor/status-bar");
  await Promise.allSettled([
    StatusBar.setOverlaysWebView({ overlay: false }),
    StatusBar.setStyle({ style: Style.Light }),
    StatusBar.setBackgroundColor({ color: "#f2f2f5" }),
  ]);
}
