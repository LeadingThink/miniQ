import type { BrowserBounds } from "./browserWorkbench";
import type { AppPlatform } from "./platforms";

export interface PlatformOverlaySnapshot {
  platform: AppPlatform;
  anchor: { left: number; top: number; bottom: number; width: number; height: number };
  requestId: string;
}

// Closing must follow an unfinished open so a late native attachment cannot
// cover the workspace after the user has already dismissed the menu.
let queue = Promise.resolve();
function command(name: string, args: Record<string, unknown> = {}): Promise<void> {
  const result = queue.then(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(name, args);
  });
  queue = result.catch(() => undefined);
  return result;
}

export function openPlatformOverlay(bounds: BrowserBounds, snapshot: PlatformOverlaySnapshot): Promise<void> {
  return command("platform_overlay_open", { bounds, snapshot });
}

export function closePlatformOverlay(): Promise<void> {
  return command("platform_overlay_close");
}

export function signalPlatformOverlayAction(action: AppPlatform | "close") {
  return command("platform_overlay_action", { action });
}

export function listenPlatformOverlayAction(handler: (action: AppPlatform | "close") => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<string>("platform-overlay://action", ({ payload }) => {
      if (!disposed && (payload === "close" || payload === "miniq" || payload === "zaiwen")) handler(payload);
    }))
    .then((off) => { if (disposed) off(); else unlisten = off; })
    .catch(() => undefined);
  return () => { disposed = true; unlisten?.(); };
}
