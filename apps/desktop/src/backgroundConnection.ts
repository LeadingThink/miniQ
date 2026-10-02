import { Capacitor, registerPlugin } from "@capacitor/core";
import { useSyncExternalStore } from "react";

/**
 * Android "后台保持连接": a foreground service keeps the app process and the
 * relay WebSocket alive in the background, so local task notifications keep
 * working without a third-party push provider. Off by default (it shows an
 * ongoing notification and costs some battery).
 * Native side: android/.../background/MiniqBackgroundPlugin.java.
 */
export interface MiniqBackgroundPlugin {
  start(): Promise<{ running: boolean }>;
  stop(): Promise<void>;
  batteryStatus(): Promise<{ unrestricted: boolean }>;
  openBatterySettings(): Promise<void>;
}

export const MiniqBackground = registerPlugin<MiniqBackgroundPlugin>("MiniqBackground");

const STORAGE_KEY = "miniq.backgroundConnection.v1";
const CHANGE_EVENT = "miniq-background-connection-changed";

export function isBackgroundConnectionSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export function getBackgroundConnectionEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Starts or stops the native service to match the saved preference. */
export async function syncBackgroundConnection(): Promise<boolean> {
  if (!isBackgroundConnectionSupported()) return false;
  try {
    if (getBackgroundConnectionEnabled()) return (await MiniqBackground.start()).running;
    await MiniqBackground.stop();
  } catch {
    // Older APKs without the plugin: nothing to keep alive.
  }
  return false;
}

/** Saves the preference and applies it; resolves whether the service is running. */
export async function setBackgroundConnectionEnabled(enabled: boolean): Promise<boolean> {
  if (enabled) localStorage.setItem(STORAGE_KEY, "1");
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return syncBackgroundConnection();
}

export async function isBatteryUnrestricted(): Promise<boolean> {
  if (!isBackgroundConnectionSupported()) return true;
  try {
    return (await MiniqBackground.batteryStatus()).unrestricted;
  } catch {
    return true;
  }
}

export async function openBatterySettings(): Promise<boolean> {
  try {
    await MiniqBackground.openBatterySettings();
    return true;
  } catch {
    return false;
  }
}

function subscribe(notify: () => void): () => void {
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

export function useBackgroundConnectionEnabled(): boolean {
  return useSyncExternalStore(subscribe, getBackgroundConnectionEnabled, () => false);
}
