import { useSyncExternalStore } from "react";

// One midnight timer for every message, never a per-row polling interval.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
const snapshot = () => {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
};
const refresh = () => {
  clearTimeout(timer);
  if (document.visibilityState === "hidden") return;
  listeners.forEach((listener) => listener());
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  timer = setTimeout(refresh, midnight.getTime() - now.getTime() + 50);
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", refresh);
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
};

export function useCalendarDay(): void {
  useSyncExternalStore(subscribe, snapshot, () => "server");
}
