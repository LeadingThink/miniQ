import { Capacitor, registerPlugin } from "@capacitor/core";
import { useSyncExternalStore } from "react";

/**
 * Android "后台保持连接": a foreground service keeps the app process and the
 * relay WebSocket alive in the background, so local task notifications keep
 * working without a third-party push provider. Off by default (it shows an
 * ongoing notification and costs some battery).
 * Native side: android/.../background/MiniqBackgroundPlugin.java.
 */
export interface BackgroundConnectionStatus {
  running: boolean;
  notificationsEnabled: boolean;
  error?: string;
}

export interface MiniqBackgroundPlugin {
  start(): Promise<BackgroundConnectionStatus>;
  status(): Promise<BackgroundConnectionStatus>;
  openNotificationSettings(): Promise<void>;
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

/** Only persist enabled after the foreground service confirms it is running. */
export async function setBackgroundConnectionEnabled(enabled: boolean): Promise<boolean> {
  if (!isBackgroundConnectionSupported()) return false;
  if (!enabled) {
    await MiniqBackground.stop();
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return false;
  }
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    let permission = await LocalNotifications.checkPermissions();
    if (permission.display === "prompt" || permission.display === "prompt-with-rationale") {
      permission = await LocalNotifications.requestPermissions();
    }
    if (permission.display !== "granted") {
      throw new Error("请在系统设置中允许 miniQ 发送通知，然后重新开启后台连接。");
    }
    const status = await MiniqBackground.start();
    if (!status.notificationsEnabled) {
      throw new Error("后台连接通知已被关闭，请在系统通知设置中启用「后台保持连接」。");
    }
    if (!status.running) throw new Error("后台连接服务未能启动，请保持 miniQ 在前台后重试。");
    localStorage.setItem(STORAGE_KEY, "1");
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return true;
  } catch (error) {
    await MiniqBackground.stop().catch(() => undefined);
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
    throw error;
  }
}

export async function getBackgroundConnectionStatus(): Promise<BackgroundConnectionStatus> {
  try {
    return await MiniqBackground.status();
  } catch {
    return { running: false, notificationsEnabled: false, error: "unavailable" };
  }
}

export async function openBackgroundNotificationSettings(): Promise<boolean> {
  try {
    await MiniqBackground.openNotificationSettings();
    return true;
  } catch {
    return false;
  }
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
