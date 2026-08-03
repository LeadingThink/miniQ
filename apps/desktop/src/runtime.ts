export function isTauriRuntime(): boolean {
  const browserWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return Boolean(browserWindow.__TAURI_INTERNALS__);
}
