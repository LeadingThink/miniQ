import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";

const STORAGE_KEY = "miniq.keepAwake.v1";
const CHANGE_EVENT = "miniq-keep-awake-changed";

export function getKeepAwake(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setKeepAwake(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useKeepAwake(busy: boolean): boolean {
  const [enabled, setEnabled] = useState(getKeepAwake);

  useEffect(() => {
    const refresh = () => setEnabled(getKeepAwake());
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const active = enabled && busy;
    void invoke("set_keep_awake", { enabled: active }).catch(() => {
      // The toggle remains useful on platforms without a native sleep lock.
    });
    return () => {
      if (active) void invoke("set_keep_awake", { enabled: false }).catch(() => {});
    };
  }, [busy, enabled]);

  return enabled;
}
