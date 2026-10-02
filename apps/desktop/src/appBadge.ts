import { Capacitor } from "@capacitor/core";
import { isNativeMobileApp } from "./mobileRuntime";
import { MiniqPush } from "./miniqPushPlugin";

/**
 * App icon badge on the phone: the number of sessions with an alert the user
 * has not seen yet, like unread chats in a messenger.
 *
 * The count lives natively (App Group on iOS, SharedPreferences on Android) so
 * remote pushes delivered while miniQ is closed and local notifications posted
 * while it is in the background add to the same number. Opening miniQ clears
 * it, since the session list already shows what needs attention.
 */
function available(): boolean {
  return isNativeMobileApp() && Capacitor.isPluginAvailable("MiniqPush");
}

export function badgeSessionKey(host: string | null, sessionId: string): string {
  return host === null ? sessionId : `${host}\u0000${sessionId}`;
}

/** Best effort: a missing badge must never block the notification itself. */
export async function markAppBadge(host: string | null, sessionId: string): Promise<number | null> {
  if (!available()) return null;
  try {
    return (await MiniqPush.markBadge({ session: badgeSessionKey(host, sessionId) })).count;
  } catch {
    return null;
  }
}

export async function clearAppBadge(): Promise<void> {
  if (!available()) return;
  await MiniqPush.clearBadge().catch(() => undefined);
}

/** Clears the badge now and whenever miniQ returns to the foreground. */
export function startAppBadge(): () => void {
  if (!available()) return () => undefined;
  let disposed = false;
  let remove: (() => Promise<void>) | null = null;
  void clearAppBadge();
  void import("@capacitor/app").then(async ({ App }) => {
    const handle = await App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void clearAppBadge();
    });
    if (disposed) void handle.remove();
    else remove = () => handle.remove();
  }).catch(() => undefined);
  return () => {
    disposed = true;
    void remove?.();
  };
}
