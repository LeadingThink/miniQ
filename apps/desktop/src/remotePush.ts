import { useSyncExternalStore } from "react";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { MiniqPush } from "./miniqPushPlugin";
import type { RpcClient } from "./rpc";
import { isNativeMobileApp } from "./mobileRuntime";
import { loadRemoteCredentials } from "./remoteAccess";
import { decryptRemotePayload, deriveRemoteIdentity, deriveRemotePushKey } from "./remoteCrypto";
import { subscribeTaskNotificationSettings, wantedTaskKinds, type TaskNotificationTarget } from "./taskNotifications";
import { getQuietHours, subscribeQuietHours } from "./quietHours";
import { decisionOf, registerNotificationActions, resolveFromNotification } from "./notificationActions";

/**
 * Offline push for the phone app.
 *
 * While the relay connection is alive the event stream drives notifications.
 * Once iOS/Android suspends the app, the desktop daemon sends an encrypted
 * push frame to the relay, which forwards the ciphertext to APNs (iOS) or
 * JPush (Android). The phone decrypts it natively (Notification Service
 * Extension / Android receiver) with the shared AES key stored by this module.
 */
export type RemotePushStatus =
  | "unsupported"     // platform or native push module unavailable
  | "off"             // user disabled every notification kind
  | "needs_permission"
  | "denied"          // system notification permission refused
  | "registering"
  | "active"
  | "server_disabled" // relay has no APNs/JPush credentials
  | "error";


let status: RemotePushStatus = "unsupported";
let appActive = true;
const statusListeners = new Set<() => void>();

function setStatus(next: RemotePushStatus) {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener();
}

export function getRemotePushStatus(): RemotePushStatus {
  return status;
}

export function useRemotePushStatus(): RemotePushStatus {
  return useSyncExternalStore(
    (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    getRemotePushStatus,
    () => "unsupported",
  );
}

/** True when the relay will push this host's events to this phone. */
export function isRemotePushCovering(host: string | null): boolean {
  return host === null && status === "active" && !appActive;
}

export function remotePushPlatform(): "apns" | "jpush" | null {
  if (!isNativeMobileApp()) return null;
  const platform = Capacitor.getPlatform();
  if (platform === "ios") return "apns";
  if (platform === "android" && Capacitor.isPluginAvailable("MiniqPush")) return "jpush";
  return null;
}

interface PushEnvelope {
  nonce?: unknown;
  ciphertext?: unknown;
}

interface PushPlaintext {
  v?: unknown;
  roomId?: unknown;
  desktopDeviceId?: unknown;
  desktopDeviceName?: unknown;
  deviceName?: unknown;
  sessionId?: unknown;
  approvalId?: unknown;
  miniqTargetDeviceId?: unknown;
  targetDeviceId?: unknown;
}

export type PushTarget = TaskNotificationTarget & { approvalId?: string; deviceName?: string };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Resolves the conversation (and pending approval) a tapped push belongs to. */
export async function pushTarget(data: Record<string, unknown> | undefined): Promise<PushTarget | null> {
  if (!data) return null;
  // The NSE / Android receiver already decrypted the payload.
  const decrypted = text(data.miniqSessionId);
  const directTargetDeviceId = text(data.miniqDesktopDeviceId) ?? text(data.miniqTargetDeviceId) ?? text(data.targetDeviceId);
  const credentials = await loadRemoteCredentials();
  if (!credentials) return null;
  const identity = await deriveRemoteIdentity(credentials.apiKey);
  if (decrypted && text(data.miniqRoomId) !== identity.roomId) return null;
  if (decrypted && !directTargetDeviceId) return null;
  if (decrypted) return { host: null, sessionId: decrypted, approvalId: text(data.miniqApprovalId), ...(text(data.miniqDeviceName) ? { deviceName: text(data.miniqDeviceName) } : {}), ...(directTargetDeviceId ? { targetDeviceId: directTargetDeviceId } : {}) };
  let envelope = data.miniq as PushEnvelope | string | undefined;
  if (typeof envelope === "string") {
    try { envelope = JSON.parse(envelope) as PushEnvelope; } catch { return null; }
  }
  const nonce = envelope?.nonce ?? data.miniqNonce;
  const ciphertext = envelope?.ciphertext ?? data.miniqCiphertext;
  if (typeof nonce !== "string" || typeof ciphertext !== "string") return null;
  try {
    const { encryptionKey } = identity;
    const payload = await decryptRemotePayload<PushPlaintext>(encryptionKey, nonce, ciphertext);
    const sessionId = text(payload.sessionId);
    const targetDeviceId = text(payload.desktopDeviceId) ?? text(payload.miniqTargetDeviceId) ?? text(payload.targetDeviceId);
    if (payload.roomId !== identity.roomId || !targetDeviceId) return null;
    const deviceName = text(payload.desktopDeviceName) ?? text(payload.deviceName);
    return sessionId ? { host: null, sessionId, approvalId: text(payload.approvalId), ...(deviceName ? { deviceName } : {}), ...(targetDeviceId ? { targetDeviceId } : {}) } : null;
  } catch {
    return null;
  }
}

/**
 * Starts push registration and foreground reporting for a remote client.
 * Returns a disposer. Safe to call on non-mobile runtimes (no-op).
 */
export function startRemotePush(client: RpcClient, open: (target: TaskNotificationTarget) => void): () => void {
  if (!isNativeMobileApp()) return () => undefined;
  const platform = remotePushPlatform();
  let disposed = false;
  let token: string | null = null;
  let syncing: Promise<void> = Promise.resolve();
  const handles: Array<Promise<PluginListenerHandle> | (() => void)> = [];

  /** Tapped push: apply an approve/reject action first, then show the session. */
  const handleOpened = (data: Record<string, unknown> | undefined, actionId: string | undefined) => {
    void pushTarget(data).then(async (target) => {
      if (disposed || !target) return;
      const decision = decisionOf(actionId);
      if (decision) await resolveFromNotification(client, target.sessionId, target.approvalId, decision, target);
      if (disposed) return;
      open({ host: target.host, sessionId: target.sessionId, ...(target.targetDeviceId ? { targetDeviceId: target.targetDeviceId } : {}) });
    }).catch(() => undefined);
  };

  const reportForeground = (active: boolean) => {
    if (disposed) return;
    appActive = active;
    client.setRelayControl({ type: "app_state", foreground: active });
  };

  const register = () => {
    if (disposed || !token || !platform || !client.targetDeviceId) {
      // Discovery-only clients have no authenticated desktop binding and must
      // never create a push registration in the relay.
      client.clearRelayControl("push_register");
      return;
    }
    const quiet = getQuietHours();
    client.clearRelayControl("push_unregister");
    client.setRelayControl({
      type: "push_register",
      platform,
      token,
      environment: "production",
      kinds: wantedTaskKinds(),
      targetDeviceId: client.targetDeviceId,
      ...(quiet ? { quietHours: quiet } : {}),
    });
  };

  const unregister = (next: RemotePushStatus) => {
    client.clearRelayControl("push_register");
    client.setRelayControl({ type: "push_unregister" });
    setStatus(next);
  };

  const sync = async () => {
    if (disposed) return;
    if (!platform) return setStatus("unsupported");
    if (wantedTaskKinds().length === 0) {
      if (Capacitor.isPluginAvailable("MiniqPush")) await MiniqPush.clearKey().catch(() => undefined);
      if (disposed) return;
      return unregister("off");
    }
    const credentials = await loadRemoteCredentials();
    if (disposed) return;
    if (!credentials) return setStatus("unsupported");
    if (Capacitor.isPluginAvailable("MiniqPush")) {
      await MiniqPush.setKey({ key: await deriveRemotePushKey(credentials.apiKey) }).catch(() => undefined);
      if (disposed) return;
    }
    if (platform === "apns") {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      const permission = await PushNotifications.checkPermissions();
      if (disposed) return;
      if (permission.receive === "denied") return unregister("denied");
      if (permission.receive !== "granted") return unregister("needs_permission");
      if (status !== "active") setStatus("registering");
      // iOS returns the (possibly rotated) token through the registration event.
      await PushNotifications.register();
    } else {
      const permission = await import("@capacitor/local-notifications")
        .then(({ LocalNotifications }) => LocalNotifications.checkPermissions())
        .catch(() => ({ display: "denied" as const }));
      if (disposed) return;
      if (permission.display === "denied") return unregister("denied");
      if (permission.display !== "granted") return unregister("needs_permission");
      if (status !== "active") setStatus("registering");
      token = (await MiniqPush.getToken()).token;
      register();
    }
  };
  const resync = () => {
    if (disposed) return;
    syncing = syncing.then(sync).catch(() => { if (!disposed) setStatus("error"); });
  };

  void import("@capacitor/app").then(({ App }) => {
    if (disposed) return;
    void App.getState().then(({ isActive }) => reportForeground(isActive)).catch(() => undefined);
    handles.push(App.addListener("appStateChange", ({ isActive }) => {
      reportForeground(isActive);
      // Permissions can change in system settings and tokens can rotate.
      if (isActive) resync();
    }));
  }).catch(() => undefined);

  // iOS: the APNs payload names this category for attention pushes.
  void registerNotificationActions();
  if (platform === "apns") {
    void import("@capacitor/push-notifications").then(({ PushNotifications }) => {
      if (disposed) return;
      handles.push(PushNotifications.addListener("registration", ({ value }) => {
        token = value;
        register();
      }));
      handles.push(PushNotifications.addListener("registrationError", () => { if (!disposed) setStatus("error"); }));
      handles.push(PushNotifications.addListener("pushNotificationActionPerformed", ({ actionId, notification }) => {
        handleOpened(notification.data as Record<string, unknown>, actionId);
      }));
    }).catch(() => { if (!disposed) setStatus("error"); });
  }
  if (Capacitor.isPluginAvailable("MiniqPush")) {
    handles.push(MiniqPush.addListener("notificationOpened", (data) => {
      handleOpened(data, text(data.actionId));
    }));
  }

  handles.push(client.onRelayMessage((message) => {
    if (disposed) return;
    if (message.type !== "push_registered" || !token) return;
    if (message.targetDeviceId !== client.targetDeviceId) return;
    setStatus(message.enabled === true ? "active" : "server_disabled");
  }));
  handles.push(client.onStatus((connected) => { if (!disposed && connected) resync(); }));
  handles.push(subscribeTaskNotificationSettings(resync));
  handles.push(subscribeQuietHours(resync));
  window.addEventListener("miniq-remote-push-refresh", resync);
  handles.push(() => window.removeEventListener("miniq-remote-push-refresh", resync));
  resync();

  return () => {
    disposed = true;
    for (const handle of handles) {
      if (typeof handle === "function") handle();
      else void handle.then((listener) => listener.remove()).catch(() => undefined);
    }
  };
}

/** Re-runs permission and registration checks, e.g. after granting permission. */
export function refreshRemotePush(): void {
  window.dispatchEvent(new Event("miniq-remote-push-refresh"));
}

/**
 * Asks for the permission offline push needs (only from an explicit tap), then
 * re-runs registration. Returns true when the permission is now granted.
 */
export async function requestRemotePushPermission(): Promise<boolean> {
  const platform = remotePushPlatform();
  if (!platform) return false;
  let granted: boolean;
  try {
    if (platform === "apns") {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      granted = (await PushNotifications.requestPermissions()).receive === "granted";
    } else {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      granted = (await LocalNotifications.requestPermissions()).display === "granted";
    }
  } catch {
    granted = false;
  }
  refreshRemotePush();
  return granted;
}

/**
 * Removes this phone from the current relay room before the API key changes or
 * remote access ends, so the old desktop stops pushing to it.
 */
export async function unregisterRemotePush(client: RpcClient, options: { clearKey?: boolean } = {}): Promise<void> {
  if (!isNativeMobileApp()) return;
  client.clearRelayControl("push_register");
  client.setRelayControl({ type: "push_unregister" });
  setStatus("registering");
  if (options.clearKey && Capacitor.isPluginAvailable("MiniqPush")) await MiniqPush.clearKey().catch(() => undefined);
  // Give the socket a moment to flush before the caller closes it.
  await new Promise((resolve) => window.setTimeout(resolve, 150));
}
