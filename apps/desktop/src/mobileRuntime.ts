import { Capacitor } from "@capacitor/core";

export function isNativeMobileApp(): boolean {
  return Capacitor.isNativePlatform();
}

export async function initializeMobileRuntime(): Promise<void> {
  if (!isNativeMobileApp()) return;
  document.documentElement.classList.add("native-mobile");
  const { StatusBar, Style } = await import("@capacitor/status-bar");
  await Promise.allSettled([
    StatusBar.setOverlaysWebView({ overlay: false }),
    StatusBar.setStyle({ style: Style.Light }),
    StatusBar.setBackgroundColor({ color: "#f2f2f5" }),
  ]);
}
