import { useSyncExternalStore } from "react";

/**
 * Quiet hours ("免打扰时段"): notifications still arrive but without sound,
 * vibration or a banner interruption. The relay applies the same window to
 * offline pushes, so the time zone travels with the setting.
 */
export interface QuietHours {
  /** "HH:MM", local time. */
  start: string;
  /** "HH:MM", local time; may be earlier than start (overnight window). */
  end: string;
  /** IANA time zone of the phone, e.g. "Asia/Shanghai". */
  timeZone: string;
}

const STORAGE_KEY = "miniq.taskNotifications.quiet.v1";
const CHANGE_EVENT = "miniq-quiet-hours-changed";
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

let cachedRaw: string | null | undefined;
let cachedValue: QuietHours | null = null;

export function getQuietHours(): QuietHours | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  cachedValue = null;
  if (raw) {
    try {
      const value = JSON.parse(raw) as Partial<QuietHours>;
      if (typeof value.start === "string" && TIME.test(value.start) && typeof value.end === "string" && TIME.test(value.end)) {
        cachedValue = { start: value.start, end: value.end, timeZone: typeof value.timeZone === "string" && value.timeZone ? value.timeZone : localTimeZone() };
      }
    } catch { /* ignore malformed settings */ }
  }
  return cachedValue;
}

export function setQuietHours(value: { start: string; end: string } | null): void {
  if (value && (!TIME.test(value.start) || !TIME.test(value.end))) throw new Error("时间格式应为 HH:MM");
  if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, timeZone: localTimeZone() }));
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeQuietHours(notify: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) notify();
  };
  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener("storage", onStorage);
  };
}

export function useQuietHours(): QuietHours | null {
  return useSyncExternalStore(subscribeQuietHours, getQuietHours, () => null);
}

function minutes(value: string): number {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
}

/** True when `now` falls inside the window. Equal start and end means all day. */
export function isWithinQuietHours(quiet: QuietHours | null, now: Date = new Date()): boolean {
  if (!quiet) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
