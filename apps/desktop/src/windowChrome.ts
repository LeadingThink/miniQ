import { isTauriRuntime } from "./runtime";

/** macOS desktop windows use an overlay title bar (see tauri.conf.json):
 *  the traffic lights float over the web content, so the shell reserves room
 *  for them and exposes drag regions. Other platforms keep native chrome. */
export function isMacDesktop(
  tauri = isTauriRuntime(),
  platform = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`,
): boolean {
  return tauri && /Mac/i.test(platform) && !/iPhone|iPad|iPod/i.test(platform);
}

export function initializeWindowChrome(root: HTMLElement = document.documentElement): void {
  if (isMacDesktop()) root.classList.add("platform-macos");
}
