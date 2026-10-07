import { useSyncExternalStore } from "react";

export type TaskNotificationKind = "completed" | "failed" | "attention";

/** Where a notification leads when tapped. `host` is null for the paired desktop itself. */
export interface TaskNotificationTarget {
  host: string | null;
  sessionId: string;
  /** Device identity that owns the session when it came from a remote client. */
  targetDeviceId?: string;
}

export interface TaskBanner {
  id: number;
  kind: TaskNotificationKind;
  title: string;
  body: string;
  target: TaskNotificationTarget;
}

let current: TaskBanner | null = null;
let nextId = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** Notifications for the same session replace each other instead of stacking. */
export function showTaskBanner(banner: Omit<TaskBanner, "id">, durationMs = 6000): void {
  if (timer) clearTimeout(timer);
  current = { ...banner, id: ++nextId };
  const id = current.id;
  timer = setTimeout(() => { if (current?.id === id) dismissTaskBanner(); }, durationMs);
  emit();
}

export function dismissTaskBanner(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!current) return;
  current = null;
  emit();
}

export function getTaskBanner(): TaskBanner | null {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTaskBanner(): TaskBanner | null {
  return useSyncExternalStore(subscribe, getTaskBanner, () => null);
}
