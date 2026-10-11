import { isTauriRuntime } from "./runtime";

/** Main's navigation consumer must resolve both IDs against its LOCAL catalog. */
export type CompanionDestination =
  | { action: "session"; sessionId: string; workspaceId: string }
  | { action: "settings" }
  | { action: "voice"; workspaceId: string; sessionId?: string | null };
export const COMPANION_NATIVE_NAVIGATION = "companion:navigate";
export const COMPANION_NAVIGATION_EVENT = "miniq:companion-navigate";
let pending: CompanionDestination | null = null;
let consumers = 0;

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
export function isCompanionDestination(value: unknown): value is CompanionDestination {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.action === "settings") return true;
  if (!validId(item.workspaceId)) return false;
  return item.action === "session" ? validId(item.sessionId)
    : item.action === "voice" && (item.sessionId == null || validId(item.sessionId));
}

export function dispatchCompanionNavigation(value: unknown): boolean {
  if (!isCompanionDestination(value)) return false;
  // Keep the latest request until useMiniqApp mounts, avoiding startup races.
  if (consumers === 0) pending = value;
  window.dispatchEvent(new CustomEvent(COMPANION_NAVIGATION_EVENT, { detail: value }));
  return true;
}

/** Mount in the main app; retain requests in the consumer until LOCAL catalog is ready. */
export function subscribeCompanionNavigation(handler: (destination: CompanionDestination) => void): () => void {
  const listener = (event: Event) => {
    const value = (event as CustomEvent<unknown>).detail;
    if (isCompanionDestination(value)) handler(value);
  };
  consumers++;
  window.addEventListener(COMPANION_NAVIGATION_EVENT, listener);
  if (pending) { const value = pending; pending = null; handler(value); }
  return () => { consumers--; window.removeEventListener(COMPANION_NAVIGATION_EVENT, listener); };
}

type Listen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
export function initializeCompanionBridge(listen?: Listen): () => void {
  if (!listen && !isTauriRuntime()) return () => undefined;
  let disposed = false;
  let off: (() => void) | undefined;
  const subscribe = listen ? Promise.resolve(listen) : import("@tauri-apps/api/event").then((module) => module.listen as Listen);
  void subscribe.then((fn) => fn(COMPANION_NATIVE_NAVIGATION, (event) => dispatchCompanionNavigation(event.payload)))
    .then((dispose) => { if (disposed) dispose(); else off = dispose; })
    .catch((error) => console.error("Companion navigation listener failed", error));
  return () => { disposed = true; off?.(); };
}

export async function openCompanionMain(destination: CompanionDestination): Promise<void> {
  if (!isCompanionDestination(destination)) throw new Error("请选择有效的本机项目和会话");
  if (!isTauriRuntime()) { dispatchCompanionNavigation(destination); return; }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("companion_open_main", { destination });
}
