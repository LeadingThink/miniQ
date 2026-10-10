import { isTauriRuntime } from "./runtime";

export type CompanionMode = "hidden" | "dots" | "pet";
export interface CompanionPrefs {
  mode: CompanionMode;
  position?: { x: number; y: number } | null;
}
export const DEFAULT_COMPANION_PREFS: CompanionPrefs = { mode: "hidden", position: null };
export const COMPANION_PREFS_EVENT = "companion:prefs";

export function parseCompanionPrefs(value: unknown): CompanionPrefs {
  if (!value || typeof value !== "object") return { ...DEFAULT_COMPANION_PREFS };
  const prefs = value as Record<string, unknown>;
  const mode = prefs.mode === "dots" || prefs.mode === "pet" ? prefs.mode : "hidden";
  const position = prefs.position as Record<string, unknown> | undefined;
  const valid = position && Number.isInteger(position.x) && Number.isInteger(position.y)
    && Math.abs(Number(position.x)) <= 2147483647 && Math.abs(Number(position.y)) <= 2147483647;
  return { mode, position: valid ? { x: Number(position.x), y: Number(position.y) } : null };
}

export async function readCompanionPrefs(): Promise<CompanionPrefs> {
  if (!isTauriRuntime()) return { ...DEFAULT_COMPANION_PREFS };
  const { invoke } = await import("@tauri-apps/api/core");
  return parseCompanionPrefs(await invoke("companion_get_prefs"));
}

export async function setCompanionMode(mode: CompanionMode): Promise<CompanionPrefs> {
  if (!isTauriRuntime()) throw new Error("桌面伙伴仅在 miniQ 桌面应用可用");
  const { invoke } = await import("@tauri-apps/api/core");
  return parseCompanionPrefs(await invoke("companion_set_mode", { mode }));
}

export async function listenCompanionPrefs(handler: (prefs: CompanionPrefs) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen(COMPANION_PREFS_EVENT, (event) => handler(parseCompanionPrefs(event.payload)));
}
