import { useSyncExternalStore } from "react";
import { isNativeMobileApp } from "./mobileRuntime";
import { isAppInBackground } from "./appFocus";
import { getQuietHours, isWithinQuietHours } from "./quietHours";
import type { TaskNotificationKind } from "./taskBanner";

const CHANGE_EVENT = "miniq-task-sounds-changed";
const SOUND_STORAGE_KEY = "miniq.taskNotifications.sound.v1";

export interface TaskSoundSettings {
  enabled: boolean;
  completed: boolean;
  failed: boolean;
  attention: boolean;
  backgroundOnly: boolean;
  volume: number;
}

export const DEFAULT_TASK_SOUND_SETTINGS: TaskSoundSettings = {
  enabled: true,
  completed: true,
  failed: true,
  attention: true,
  backgroundOnly: true,
  volume: 0.55,
};

let soundSnapshot: { raw: string | null; settings: TaskSoundSettings } | null = null;

function clampVolume(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : DEFAULT_TASK_SOUND_SETTINGS.volume;
}

export function getTaskSoundSettings(): TaskSoundSettings {
  let raw: string | null = null;
  try { raw = localStorage.getItem(SOUND_STORAGE_KEY); } catch { raw = null; }
  if (soundSnapshot?.raw === raw) return soundSnapshot.settings;
  let settings = DEFAULT_TASK_SOUND_SETTINGS;
  try {
    const parsed = raw ? JSON.parse(raw) as Partial<TaskSoundSettings> : null;
    if (parsed && typeof parsed === "object") {
      settings = {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_TASK_SOUND_SETTINGS.enabled,
        completed: typeof parsed.completed === "boolean" ? parsed.completed : DEFAULT_TASK_SOUND_SETTINGS.completed,
        failed: typeof parsed.failed === "boolean" ? parsed.failed : DEFAULT_TASK_SOUND_SETTINGS.failed,
        attention: typeof parsed.attention === "boolean" ? parsed.attention : DEFAULT_TASK_SOUND_SETTINGS.attention,
        backgroundOnly: typeof parsed.backgroundOnly === "boolean" ? parsed.backgroundOnly : DEFAULT_TASK_SOUND_SETTINGS.backgroundOnly,
        volume: clampVolume(parsed.volume),
      };
    }
  } catch { settings = DEFAULT_TASK_SOUND_SETTINGS; }
  soundSnapshot = { raw, settings };
  return settings;
}

export function setTaskSoundSettings(update: Partial<TaskSoundSettings>): void {
  const settings = { ...getTaskSoundSettings(), ...update, volume: clampVolume(update.volume ?? getTaskSoundSettings().volume) };
  localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useTaskSoundSettings(): TaskSoundSettings {
  return useSyncExternalStore(subscribeSounds, getTaskSoundSettings, () => DEFAULT_TASK_SOUND_SETTINGS);
}

function subscribeSounds(notify: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SOUND_STORAGE_KEY || event.key === null) notify();
  };
  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener("storage", onStorage);
  };
}

type SoundNote = { frequency: number; duration: number };
const SOUND_NOTES: Record<TaskNotificationKind, readonly SoundNote[]> = {
  completed: [{ frequency: 660, duration: 0.09 }, { frequency: 880, duration: 0.13 }],
  failed: [{ frequency: 440, duration: 0.12 }, { frequency: 220, duration: 0.18 }],
  attention: [
    { frequency: 740, duration: 0.08 },
    { frequency: 880, duration: 0.08 },
    { frequency: 740, duration: 0.1 },
  ],
};
const playedSoundEvents = new Map<string, number>();
let audioContext: AudioContext | null = null;

/** Create/resume during a gesture; background task events never unlock audio. */
export async function unlockTaskSounds(): Promise<boolean> {
  if (isNativeMobileApp()) return false;
  try {
    const Constructor = audioContextConstructor();
    if (!Constructor) return false;
    if (!audioContext || audioContext.state === "closed") audioContext = new Constructor();
    if (audioContext.state === "suspended") await audioContext.resume();
    return audioContext.state === "running";
  } catch {
    return false;
  }
}

if (typeof document !== "undefined") {
  for (const event of ["pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(event, () => { void unlockTaskSounds(); }, { passive: true });
  }
}

function audioContextConstructor(): (new () => AudioContext) | undefined {
  if (typeof window === "undefined") return undefined;
  const browserWindow = window as typeof window & { webkitAudioContext?: new () => AudioContext };
  return window.AudioContext ?? browserWindow.webkitAudioContext;
}

/** Generates a short local tone without loading or storing an audio asset. */
export async function playTaskSound(
  kind: TaskNotificationKind,
  options: { dedupeKey?: string; dedupeWindowMs?: number; userInitiated?: boolean; ignoreSettings?: boolean } = {},
): Promise<boolean> {
  try {
    if (isNativeMobileApp()) return false;
    if (options.userInitiated && !await unlockTaskSounds()) return false;
    if (!audioContext || audioContext.state !== "running") return false;
    if (!options.ignoreSettings && getTaskSoundSettings().backgroundOnly && !await isAppInBackground()) return false;
    // Read again after the async focus check in case the user just muted sounds.
    const settings = getTaskSoundSettings();
    if (settings.volume === 0) return false;
    if (!options.ignoreSettings && (!settings.enabled || !settings[kind])) return false;
    if (!options.userInitiated && isWithinQuietHours(getQuietHours())) return false;
    const key = options.dedupeKey ? `${kind}\u0000${options.dedupeKey}` : undefined;
    if (!options.userInitiated && key) {
      const now = Date.now();
      for (const [entry, expires] of playedSoundEvents) {
        if (expires <= now) playedSoundEvents.delete(entry);
      }
      if (playedSoundEvents.has(key)) return false;
    }
    const start = audioContext.currentTime;
    let offset = 0;
    const amplitude = settings.volume * 0.18;
    for (const note of SOUND_NOTES[kind]) {
      const noteStart = start + offset;
      const noteEnd = noteStart + note.duration;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(amplitude, noteStart + 0.012);
      gain.gain.linearRampToValueAtTime(0, noteEnd);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      offset += note.duration + 0.035;
    }
    // Scheduling is synchronous after the duplicate check: commit only once
    // every note has started successfully, so a failed attempt can be retried.
    if (!options.userInitiated && key) {
      playedSoundEvents.set(key, Date.now() + (options.dedupeWindowMs ?? 300_000));
      if (playedSoundEvents.size > 1024) playedSoundEvents.delete(playedSoundEvents.keys().next().value!);
    }
    return true;
  } catch {
    // Browser autoplay restrictions and missing Web Audio implementations are
    // best effort. They must never affect delivery of the system notification.
    return false;
  }
}
