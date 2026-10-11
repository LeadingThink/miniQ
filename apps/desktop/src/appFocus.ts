import { isTauriRuntime } from "./runtime";

/** Rejects when the native window state is unavailable; callers treat that as foreground. */
export async function isAppInBackground(): Promise<boolean> {
  if (document.hasFocus()) return false;
  if (isTauriRuntime()) {
    // An embedded native browser can own focus while the React document is
    // blurred. The whole desktop window must be in the background.
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (await getCurrentWindow().isFocused()) return false;
  }
  return !document.hasFocus();
}
