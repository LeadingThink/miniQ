export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const browserWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return Boolean(browserWindow.__TAURI_INTERNALS__);
}
