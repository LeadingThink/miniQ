import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { isSessionRunning } from "./sessionStatus";
import type { SessionStatus } from "./types";

const STORAGE_KEY = "miniq.keepAwake.v1";
const CHANGE_EVENT = "miniq-keep-awake-changed";
let error: string | null = null;
const listeners = new Set<() => void>();
let nativeUpdate: Promise<void> = Promise.resolve();

function reportError(value: string | null) {
  error = value;
  listeners.forEach((notify) => notify());
}

export function getKeepAwake(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function setKeepAwake(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
    reportError(null);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    reportError("无法保存防休眠设置，请检查本机存储是否可用。");
  }
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener("storage", notify);
  };
}

export function useKeepAwakePreference() {
  const enabled = useSyncExternalStore(subscribe, getKeepAwake, () => false);
  const problem = useSyncExternalStore(subscribe, () => error, () => null);
  return { enabled, error: problem };
}

export function hasLocalRunningTasks(mode: string, sessions: readonly { status: SessionStatus }[]): boolean {
  return mode === "local" && sessions.some((session) => isSessionRunning(session.status));
}

function updateNative(enabled: boolean) {
  // Serialize cleanup/start requests so a slow previous toggle cannot win.
  nativeUpdate = nativeUpdate.then(async () => {
    try {
      await invoke("set_keep_awake", { enabled });
      reportError(null);
    } catch (cause) {
      reportError(`防休眠设置未生效：${String(cause)}`);
    }
  });
}

/** Mount once at the desktop root, outside per-host/per-conversation views. */
export function useKeepAwake(busy: boolean): void {
  const { enabled } = useKeepAwakePreference();
  useEffect(() => {
    if (!isTauriRuntime()) return;
    updateNative(enabled && busy);
    return () => { updateNative(false); };
  }, [busy, enabled]);
}
