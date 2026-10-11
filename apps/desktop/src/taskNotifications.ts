import { useSyncExternalStore } from "react";
import { isAppInBackground } from "./appFocus";
import { playTaskSound } from "./taskSounds";
export { isAppInBackground } from "./appFocus";
export { getTaskSoundSettings, setTaskSoundSettings, useTaskSoundSettings, playTaskSound } from "./taskSounds";
import { Capacitor } from "@capacitor/core";
import { isTauriRuntime } from "./runtime";
import { isNativeMobileApp } from "./mobileRuntime";
import { getQuietHours, isWithinQuietHours } from "./quietHours";
import { markAppBadge } from "./appBadge";
import { ATTENTION_ACTION_TYPE, registerNotificationActions } from "./notificationActions";
import { showTaskBanner, type TaskNotificationKind, type TaskNotificationTarget } from "./taskBanner";

export type TaskNotificationMode = "all" | "failures" | "off";
export type TaskNotificationPermission = NotificationPermission | "unsupported";
export type { TaskNotificationKind, TaskNotificationTarget } from "./taskBanner";

const STORAGE_KEY = "miniq.taskNotifications.v1";
const ATTENTION_KEY = "miniq.taskNotifications.attention.v1";
const CHANGE_EVENT = "miniq-task-notifications-changed";
const ATTENTION_CHANNEL = "miniq-attention";
const RESULT_CHANNEL = "miniq-results";
const QUIET_CHANNEL = "miniq-quiet";
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

/** Approval and question prompts block a task; they notify unless explicitly disabled. */
export function getTaskAttentionEnabled(): boolean {
  try {
    return localStorage.getItem(ATTENTION_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setTaskAttentionEnabled(enabled: boolean): void {
  localStorage.setItem(ATTENTION_KEY, enabled ? "on" : "off");
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Kinds the user wants delivered; the relay filters offline pushes with this list. */
export function wantedTaskKinds(): TaskNotificationKind[] {
  const kinds: TaskNotificationKind[] = [];
  const mode = getTaskNotificationMode();
  if (mode === "all") kinds.push("completed");
  if (mode !== "off") kinds.push("failed");
  if (getTaskAttentionEnabled()) kinds.push("attention");
  return kinds;
}

export function subscribeTaskNotificationSettings(notify: () => void): () => void {
  return subscribe(notify);
}

function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === ATTENTION_KEY || event.key === null) notify();
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

export function useTaskAttentionEnabled(): boolean {
  return useSyncExternalStore(subscribe, getTaskAttentionEnabled, () => true);
}

function wants(kind: TaskNotificationKind): boolean {
  const mode = getTaskNotificationMode();
  if (mode === "off") return false;
  if (kind === "attention") return getTaskAttentionEnabled();
  return mode === "all" || kind === "failed";
}

function mobilePermission(display: string): TaskNotificationPermission {
  return display === "granted" ? "granted" : display === "denied" ? "denied" : "default";
}

/** Reading permission never opens a system permission dialog. */
export async function getTaskNotificationPermission(): Promise<TaskNotificationPermission> {
  if (isNativeMobileApp()) {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    return mobilePermission((await LocalNotifications.checkPermissions()).display);
  }
  if (isTauriRuntime()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    return (await plugin.isPermissionGranted()) ? "granted" : "default";
  }
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Call only from the user's enable/test button, never from a task event. */
export async function requestTaskNotificationPermission(): Promise<TaskNotificationPermission> {
  if (isNativeMobileApp()) {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const current = mobilePermission((await LocalNotifications.checkPermissions()).display);
    if (current !== "default") return current;
    return mobilePermission((await LocalNotifications.requestPermissions()).display);
  }
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

let channels: Promise<void> | null = null;
function ensureAndroidChannels(plugin: typeof import("@capacitor/local-notifications")["LocalNotifications"]) {
  if (Capacitor.getPlatform() !== "android") return Promise.resolve();
  channels ??= Promise.all([
    plugin.createChannel({ id: ATTENTION_CHANNEL, name: "需要你操作", description: "任务等待审批或回答时提醒", importance: 5, vibration: true, visibility: 0 }),
    plugin.createChannel({ id: RESULT_CHANNEL, name: "任务结果", description: "任务完成或未完成时提醒", importance: 4, vibration: true, visibility: 0 }),
    plugin.createChannel({ id: QUIET_CHANNEL, name: "免打扰时段", description: "免打扰时段内静默送达", importance: 2, vibration: false, visibility: 0 }),
  ]).then(() => undefined).catch(() => { channels = null; });
  return channels;
}

/** Stable per-session id: a newer notification for the same session replaces the old one. */
export function notificationId(target: TaskNotificationTarget): number {
  const text = `${target.host ?? ""}\u0000${target.targetDeviceId ?? ""}\u0000${target.sessionId}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  return (hash & 0x7fffffff) || 1;
}

async function send(
  title: string,
  body: string,
  allowed: () => boolean | Promise<boolean>,
  kind: TaskNotificationKind = "completed",
  target?: TaskNotificationTarget,
  onClick?: () => void,
): Promise<boolean> {
  try {
    if (!await allowed() || await getTaskNotificationPermission() !== "granted" || !await allowed()) return false;
    if (isNativeMobileApp()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      await ensureAndroidChannels(LocalNotifications);
      if (kind === "attention") await registerNotificationActions();
      if (!await allowed()) return false;
      const quiet = isWithinQuietHours(getQuietHours());
      await LocalNotifications.schedule({ notifications: [{
        id: target ? notificationId(target) : 1,
        title,
        body,
        channelId: quiet ? QUIET_CHANNEL : kind === "attention" ? ATTENTION_CHANNEL : RESULT_CHANNEL,
        threadIdentifier: target ? `session:${target.sessionId}` : undefined,
        group: target ? `session:${target.sessionId}` : undefined,
        // Without the Time Sensitive entitlement iOS treats this as "active".
        // Quiet hours: delivered to Notification Center without sound or banner.
        interruptionLevel: quiet ? "passive" : kind === "attention" ? "timeSensitive" : "active",
        // Approve / reject buttons; only for this phone's own desktop, whose
        // approvals the root client can resolve directly.
        actionTypeId: kind === "attention" && target?.host === null ? ATTENTION_ACTION_TYPE : undefined,
        extra: target ? { miniqTarget: target, ...(target.targetDeviceId ? { miniqTargetDeviceId: target.targetDeviceId } : {}) } : undefined,
      }] });
      if (target) void markAppBadge(target.host, target.sessionId);
    } else if (isTauriRuntime()) {
      const plugin = await import("@tauri-apps/plugin-notification");
      if (!await allowed()) return false;
      plugin.sendNotification({ title, body });
    } else {
      const notification = new Notification(title, { body });
      if (onClick) notification.onclick = () => { window.focus(); onClick(); notification.close(); };
    }
    return true;
  } catch {
    // The chosen platform owns delivery. A native failure must not trigger a
    // second web notification or a permission request in the background.
    return false;
  }
}

/** Tells the host owner that a remote device raised a session's permissions. */
export function notifyRemotePermissionRaise(device: string, mode: string): Promise<boolean> {
  return send("miniQ · 远程提升了权限", `设备 ${device} 将会话权限提升为「${mode}」，可在 miniQ 中一键撤回。`, () => true);
}

function copy(kind: TaskNotificationKind, sessionTitle: string): { title: string; body: string } {
  const name = sessionTitle || "当前会话";
  if (kind === "attention") return { title: "miniQ · 需要你操作", body: `「${name}」正在等待审批或回答，请返回 miniQ 处理。` };
  if (kind === "completed") return { title: "miniQ · 任务完成", body: `「${name}」已完成，请返回 miniQ 查看结果。` };
  return { title: "miniQ · 任务未完成", body: `「${name}」执行未完成，请返回 miniQ 查看详情并继续任务。` };
}

export async function notifyTaskResult(
  outcome: TaskNotificationKind,
  sessionTitle: string,
  target?: TaskNotificationTarget,
  eventId?: string,
): Promise<boolean> {
  const background = await isAppInBackground().catch(() => false);
  const { title, body } = copy(outcome, sessionTitle);
  playEventSound(outcome, target, eventId, sessionTitle);
  if (!wants(outcome)) return false;
  if (!background) {
    showTaskBanner({ kind: outcome, title, body, target: target ?? { host: null, sessionId: "" } });
    return true;
  }
  return send(title, body, async () => await isAppInBackground() && wants(outcome), outcome, target);
}

function playEventSound(kind: TaskNotificationKind, target: TaskNotificationTarget | undefined, eventId: string | undefined, fallback: string): void {
  const scope = [target?.host, target?.targetDeviceId, target?.sessionId];
  void playTaskSound(kind, {
    dedupeKey: JSON.stringify([...scope, eventId ?? fallback]),
    // Legacy callers without an event id only coalesce immediate duplicates.
    dedupeWindowMs: eventId ? 300_000 : 2_000,
  });
}

/**
 * Phone delivery. In the foreground an in-app banner plus a light haptic
 * replaces the system notification, and the conversation on screen is skipped.
 * In the background (connection still alive) a local system notification is
 * posted; notifications of one session replace each other.
 */
export async function notifyMobileTask(
  kind: TaskNotificationKind,
  sessionTitle: string,
  target: TaskNotificationTarget,
  viewing: boolean,
): Promise<boolean> {
  if (!wants(kind)) return false;
  const { title, body } = copy(kind, sessionTitle);
  if (document.visibilityState === "visible") {
    if (viewing) return false;
    showTaskBanner({ kind, title, body, target });
    if (!isWithinQuietHours(getQuietHours())) void vibrate(kind);
    return true;
  }
  // Registration is not a delivery receipt. Keep the local fallback when an
  // event reaches this process, even if offline push is registered.
  return send(title, body, () => document.visibilityState !== "visible" && wants(kind), kind, target);
}

async function vibrate(kind: TaskNotificationKind): Promise<void> {
  try {
    const { Haptics, ImpactStyle, NotificationType } = await import("@capacitor/haptics");
    if (kind === "attention") await Haptics.notification({ type: NotificationType.Warning });
    else await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Haptics are best effort; the banner is the actual notification.
  }
}

export type AttentionKind = "approval" | "question";
export type AttentionNotificationPrefs = Record<AttentionKind, boolean>;
const ATTENTION_STORAGE_KEY = "miniq.attentionNotifications.v1";
const DEFAULT_ATTENTION: AttentionNotificationPrefs = { approval: true, question: true };
let attentionSnapshot: { raw: string | null; prefs: AttentionNotificationPrefs } | null = null;

/** Both reminders default to on; a corrupt value falls back to the defaults. */
export function getAttentionNotificationPrefs(): AttentionNotificationPrefs {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ATTENTION_STORAGE_KEY); } catch { raw = null; }
  // useSyncExternalStore needs a stable snapshot for an unchanged value.
  if (attentionSnapshot && attentionSnapshot.raw === raw) return attentionSnapshot.prefs;
  let prefs = DEFAULT_ATTENTION;
  try {
    const parsed = raw ? JSON.parse(raw) as Partial<AttentionNotificationPrefs> : null;
    if (parsed && typeof parsed === "object") {
      prefs = {
        approval: typeof parsed.approval === "boolean" ? parsed.approval : true,
        question: typeof parsed.question === "boolean" ? parsed.question : true,
      };
    }
  } catch { prefs = DEFAULT_ATTENTION; }
  attentionSnapshot = { raw, prefs };
  return prefs;
}

export function setAttentionNotificationPref(kind: AttentionKind, enabled: boolean): void {
  localStorage.setItem(ATTENTION_STORAGE_KEY, JSON.stringify({ ...getAttentionNotificationPrefs(), [kind]: enabled }));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribeAttention(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ATTENTION_STORAGE_KEY || event.key === null) notify();
  };
  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAttentionNotificationPrefs(): AttentionNotificationPrefs {
  return useSyncExternalStore(subscribeAttention, getAttentionNotificationPrefs, () => DEFAULT_ATTENTION);
}

/**
 * Reminds a backgrounded user that a session is blocked on them. `onClick` is
 * honoured by web notifications; native desktop notifications only activate
 * the app, so the caller also navigates when the window regains focus.
 */
export async function notifyAttention(
  kind: AttentionKind,
  sessionTitle: string,
  detail: string,
  onClick?: () => void,
  target?: TaskNotificationTarget,
  requestId?: string,
): Promise<boolean> {
  const background = await isAppInBackground().catch(() => false);
  const name = sessionTitle || "当前会话";
  const title = kind === "approval" ? `需要你审批：${name}` : `需要你回答：${name}`;
  const body = detail.trim().slice(0, 140) || (kind === "approval" ? "有操作等待你的批准，请返回 miniQ 处理。" : "助手在等待你的回答，请返回 miniQ 处理。");
  playEventSound("attention", target, requestId, `${kind}\u0000${name}\u0000${detail}`);
  if (!getAttentionNotificationPrefs()[kind]) return false;
  if (!background) {
    showTaskBanner({ kind: "attention", title, body, target: target ?? { host: null, sessionId: "" } });
    return true;
  }
  return send(title, body, async () => getAttentionNotificationPrefs()[kind] && await isAppInBackground(), "attention", target, onClick);
}

export function sendTaskNotificationTest(): Promise<boolean> {
  return send("miniQ · 测试通知", "通知已启用。任务在后台完成、失败或等待你操作时，miniQ 将按你的设置提醒。", () => true);
}
