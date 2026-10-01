import { isTauriRuntime } from "./runtime";

/** Must match `COMMAND_IDS` in `src-tauri/src/app_menu.rs`. */
export const MENU_COMMAND_IDS = [
  "newChat", "settings", "toggleSidebar", "palette", "find", "showShortcuts",
  "prevSession", "nextSession", "nextAttention", "archiveSession", "togglePin",
  "markUnread", "markAllRead", "back", "forward", "copyMarkdown",
] as const;
export type MenuCommandId = typeof MENU_COMMAND_IDS[number];

/** Native event name emitted by the Rust app menu. */
export const NATIVE_MENU_EVENT = "menu-command";
/** App-wide command bus consumed by the navigation layer. */
export const COMMAND_BUS_EVENT = "miniq:command";

const known = new Set<string>(MENU_COMMAND_IDS);
export const isMenuCommandId = (value: unknown): value is MenuCommandId => typeof value === "string" && known.has(value);

export function dispatchMenuCommand(id: unknown, target: Window = window): boolean {
  if (!isMenuCommandId(id)) return false;
  target.dispatchEvent(new CustomEvent(COMMAND_BUS_EVENT, { detail: { id } }));
  return true;
}

type Listen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;

/**
 * Forwards native menu selections to the `miniq:command` bus. Returns a
 * disposer; outside Tauri it is a no-op so the web/mobile builds are unaffected.
 */
export function initializeNativeMenuBridge(listen?: Listen): () => void {
  if (!listen && !isTauriRuntime()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const subscribe = listen ? Promise.resolve(listen) : import("@tauri-apps/api/event").then((module) => module.listen as Listen);
  void subscribe
    .then((fn) => fn(NATIVE_MENU_EVENT, (event) => { dispatchMenuCommand(event.payload); }))
    .then((off) => { if (disposed) off(); else unlisten = off; })
    .catch(() => undefined);
  return () => { disposed = true; unlisten?.(); };
}
