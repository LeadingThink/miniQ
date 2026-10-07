import type { RpcClient } from "./rpc";
import type { Approval } from "./types";
import { isNativeMobileApp } from "./mobileRuntime";
import type { TaskNotificationTarget } from "./taskBanner";

/**
 * "批准 / 拒绝" buttons on attention notifications (local and remote).
 *
 * Both actions open the app (iOS cannot keep a relay socket alive from a
 * notification action in the background) and require the device to be
 * unlocked, so an approval can never be granted from a locked screen.
 */
export const ATTENTION_ACTION_TYPE = "MINIQ_ATTENTION";
export const APPROVE_ACTION = "approve";
export const REJECT_ACTION = "reject";

export type NotificationDecision = "approve" | "reject";

export function decisionOf(actionId: string | undefined): NotificationDecision | null {
  return actionId === APPROVE_ACTION ? "approve" : actionId === REJECT_ACTION ? "reject" : null;
}

let registered: Promise<void> | null = null;

/** Registers the attention category once. iOS shares it with remote pushes. */
export function registerNotificationActions(): Promise<void> {
  if (!isNativeMobileApp()) return Promise.resolve();
  registered ??= import("@capacitor/local-notifications")
    .then(({ LocalNotifications }) => LocalNotifications.registerActionTypes({
      types: [{
        id: ATTENTION_ACTION_TYPE,
        actions: [
          { id: APPROVE_ACTION, title: "批准", foreground: true, requiresAuthentication: true },
          { id: REJECT_ACTION, title: "拒绝", foreground: true, destructive: true, requiresAuthentication: true },
        ],
      }],
    }))
    .then(() => undefined)
    .catch(() => { registered = null; });
  return registered;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** The app was just woken by the action; wait for the relay to come back. */
export function waitForConnection(client: RpcClient, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  if (client.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => { off(); resolve(false); }, timeoutMs);
    const off = client.onStatus((connected) => {
      if (!connected) return;
      window.clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

type InboxEntry = { approval: Approval };

/**
 * Resolves the pending approval behind a notification. Without an explicit
 * approval id (local notifications) it only acts when the session has
 * exactly one pending approval, so a tap never approves the wrong request.
 * Returns true when the decision was applied.
 */
export async function resolveFromNotification(
  client: RpcClient,
  sessionId: string,
  approvalId: string | undefined,
  decision: NotificationDecision,
  target?: Pick<TaskNotificationTarget, "targetDeviceId">,
): Promise<boolean> {
  // A notification from an older device (or without an identity) must never
  // be applied through a newly selected remote desktop.
  if (client.targetDeviceId && target?.targetDeviceId !== client.targetDeviceId) return false;
  if (!await waitForConnection(client)) return false;
  try {
    let id = approvalId;
    if (!id) {
      const page = await client.call<{ entries: InboxEntry[] }>("approval.inbox", {}, { timeoutMs: 10_000 });
      const pending = page.entries.filter((entry) => entry.approval.sessionId === sessionId && entry.approval.status === "pending");
      if (pending.length !== 1) return false;
      id = pending[0].approval.id;
    }
    await client.call("approval.resolve", { approvalId: id, decision }, { timeoutMs: 10_000 });
    return true;
  } catch {
    // Already resolved elsewhere, expired, or the desktop went away: the
    // caller opens the conversation so the user sees the real state.
    return false;
  }
}
