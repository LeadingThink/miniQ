import type { ContextUsage } from "./contextUsage";
import type { BrowserBounds } from "./browserWorkbench";
import { isTauriRuntime } from "./runtime";

export interface ContextUsageOverlaySnapshot {
  usage: ContextUsage | null;
  loading: boolean;
  error: string | null;
}

async function invokeOverlay(command: string, args: Record<string, unknown> = {}): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(command, args);
}

let overlayCommandQueue = Promise.resolve();

function enqueueOverlayCommand<T>(command: () => Promise<T>): Promise<T> {
  const result = overlayCommandQueue.then(command, command);
  overlayCommandQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function contextUsageOverlayBounds(anchor: DOMRect, viewportWidth: number, viewportHeight: number): BrowserBounds {
  const gap = 12;
  const width = Math.max(1, Math.min(372, viewportWidth - gap * 2));
  const height = Math.max(1, Math.min(620, viewportHeight - gap * 2));
  const maxX = Math.max(0, viewportWidth - width);
  const maxY = Math.max(0, viewportHeight - height);
  return {
    x: Math.max(0, Math.min(Math.max(gap, anchor.right - width), maxX)),
    y: Math.max(0, Math.min(Math.max(gap, anchor.top - height - 8), maxY)),
    width,
    height,
  };
}

export async function openContextUsageOverlay(
  bounds: BrowserBounds,
  snapshot: ContextUsageOverlaySnapshot,
): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  await enqueueOverlayCommand(() => invokeOverlay("context_usage_overlay_open", { bounds, snapshot }));
  return true;
}

export async function updateContextUsageOverlay(snapshot: ContextUsageOverlaySnapshot): Promise<void> {
  if (!isTauriRuntime()) return;
  await enqueueOverlayCommand(() => invokeOverlay("context_usage_overlay_update", { snapshot }));
}

export async function closeContextUsageOverlay(): Promise<void> {
  if (!isTauriRuntime()) return;
  await enqueueOverlayCommand(() => invokeOverlay("context_usage_overlay_close"));
}

export function listenContextUsageOverlayAction(
  handler: (action: "close" | "refresh") => void,
): () => void {
  if (!isTauriRuntime()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<string>("context-usage-overlay://action", (event) => {
      if (!disposed && (event.payload === "close" || event.payload === "refresh")) handler(event.payload);
    }))
    .then((off) => { if (disposed) off(); else unlisten = off; })
    .catch(() => undefined);
  return () => { disposed = true; unlisten?.(); };
}
