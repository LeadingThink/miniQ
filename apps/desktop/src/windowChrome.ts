import { isTauriRuntime } from "./runtime";

/** macOS retains its native traffic lights in the shared title row. */
export function isMacDesktop(
  tauri = isTauriRuntime(),
  platform = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`,
): boolean {
  return tauri && /Mac/i.test(platform) && !/iPhone|iPad|iPod/i.test(platform);
}

export function isWindowsDesktop(
  tauri = isTauriRuntime(),
  platform = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`,
): boolean {
  return tauri && /Win/i.test(platform);
}

export function initializeWindowChrome(root: HTMLElement = document.documentElement): void {
  if (isMacDesktop()) root.classList.add("platform-macos");
}
