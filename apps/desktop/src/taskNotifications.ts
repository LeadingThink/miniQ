import { useSyncExternalStore } from "react";
import { isTauriRuntime } from "./runtime";

export type TaskNotificationMode = "all" | "failures" | "off";
export type TaskNotificationPermission = NotificationPermission | "unsupported";
type TaskOutcome = "completed" | "failed";

const STORAGE_KEY = "miniq.taskNotifications.v1";
const CHANGE_EVENT = "miniq-task-notifications-changed";

export function getTaskNotificationMode(): TaskNotificationMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "failures" || value === "off" ? value : "all";
  } catch {
    return "all";
  }
}

export function setTaskNotificationMode(mode: TaskNotificationMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(notify: () => void) {
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

export function useTaskNotificationMode(): TaskNotificationMode {
  return useSyncExternalStore(subscribe, getTaskNotificationMode, () => "all");
}

/** Reading permission never opens a system permission dialog. */
export async function getTaskNotificationPermission(): Promise<TaskNotificationPermission> {
  if (isTauriRuntime()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    return (await plugin.isPermissionGranted()) ? "granted" : "default";
  }
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Call only from the user's enable/test button, never from a task event. */
export async function requestTaskNotificationPermission(): Promise<TaskNotificationPermission> {
  if (isTauriRuntime()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    if (await plugin.isPermissionGranted()) return "granted";
    return plugin.requestPermission();
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission === "default"
    ? Notification.requestPermission()
    : Notification.permission;
}

async function send(title: string, body: string, allowed: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    if (!await allowed() || await getTaskNotificationPermission() !== "granted" || !await allowed()) return false;
    if (isTauriRuntime()) {
      const plugin = await import("@tauri-apps/plugin-notification");
      if (!await allowed()) return false;
      plugin.sendNotification({ title, body });
    } else {
      new Notification(title, { body });
    }
    return true;
  } catch {
    // The chosen platform owns delivery. A native failure must not trigger a
    // second web notification or a permission request in the background.
    return false;
  }
}

export async function notifyTaskResult(outcome: TaskOutcome, sessionTitle: string): Promise<boolean> {
  const allowed = async () => {
    if (document.hasFocus()) return false;
    if (isTauriRuntime()) {
      // An embedded native browser can own focus while the React document is
      // blurred. The whole desktop window must be in the background.
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (await getCurrentWindow().isFocused()) return false;
    }
    const mode = getTaskNotificationMode();
    return !document.hasFocus() && (mode === "all" || (mode === "failures" && outcome === "failed"));
  };
  const name = sessionTitle || "当前会话";
  return outcome === "completed"
    ? send("miniQ · 任务完成", `「${name}」已完成，请返回 miniQ 查看结果。`, allowed)
    : send("miniQ · 任务未完成", `「${name}」执行未完成，请返回 miniQ 查看详情并继续任务。`, allowed);
}

export function sendTaskNotificationTest(): Promise<boolean> {
  return send("miniQ · 测试通知", "通知已启用。任务在后台完成或失败时，miniQ 将按你的设置提醒。", () => true);
}
