import { useEffect, useRef } from "react";
import type { RpcClient } from "../rpc";
import type { DaemonEvent, EventCursor, SessionStatus } from "../types";
import { hostKey, scopedKey, type HostCatalog } from "../hostWorkspace";
import { clearTurnBadgeOnFocus, createTurnBadge } from "../turnBadge";
import { notifyMobileTask, notifyTaskResult, type TaskNotificationKind, type TaskNotificationTarget } from "../taskNotifications";
import { isNativeMobileApp } from "../mobileRuntime";
import { startAppBadge } from "../appBadge";
import { getRemotePushStatus, isRemotePushCovering, startRemotePush } from "../remotePush";
import { decisionOf, resolveFromNotification } from "../notificationActions";

/** Completed turns shorter than this are not worth a phone notification. */
export const SHORT_TASK_MS = 10_000;

/** After a reconnect, catalog status changes stand in for missed events this long. */
export const CATCH_UP_WINDOW_MS = 20_000;

/** Notification kind implied by a status change observed only through the catalog. */
export function missedKind(previous: SessionStatus, current: SessionStatus): TaskNotificationKind | null {
  if (previous === current) return null;
  if (current === "waiting_approval") return "attention";
  const active = previous === "running" || previous === "cancelling" || previous === "waiting_approval";
  if (!active) return null;
  if (current === "failed") return "failed";
  if (current === "idle") return "completed";
  return null;
}

export interface TaskNotificationOptions {
  /** True when this conversation is currently on screen. */
  isViewing?: (host: string | null, sessionId: string) => boolean;
  /** Navigate to a conversation after its notification or banner is tapped. */
  open?: (target: TaskNotificationTarget) => void;
}

function kindOf(event: DaemonEvent): TaskNotificationKind | null {
  if (event.type === "turn_completed") return "completed";
  if (event.type === "turn_failed") return "failed";
  // Approval and question prompts both park the session in waiting_approval.
  // Status changes reach every remote peer, unlike the prompt events themselves.
  if (event.type === "session_status_changed" && event.status === "waiting_approval") return "attention";
  return null;
}

/** One subscription at the desktop root covers every host, including hidden ones. */
export function useTaskNotifications(root: RpcClient, catalogs: Record<string, HostCatalog>, options: TaskNotificationOptions = {}) {
  const catalogsRef = useRef(catalogs);
  catalogsRef.current = catalogs;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const reconcileRef = useRef<(catalogs: Record<string, HostCatalog>) => void>(() => undefined);

  useEffect(() => {
    const mobile = isNativeMobileApp();
    const seen = new Map<string, EventCursor>();
    const badge = createTurnBadge();
    const offFocus = clearTurnBadgeOnFocus(badge);
    const started = new Map<string, number>();
    const waiting = new Set<string>();
    // Last status per session, from live events or the catalog.
    const known = new Map<string, SessionStatus>();
    // Sessions notified from the catalog; their late live event is a duplicate.
    const caughtUp = new Set<string>();
    const hostConnected = new Map<string, boolean>();
    const catchUpUntil = new Map<string, number>();
    let allCatchUpUntil = 0;

    const deliver = (host: string | null, sessionId: string, kind: TaskNotificationKind, startedAt: number | undefined, catchUp: boolean) => {
      if (mobile && kind === "completed" && startedAt !== undefined && Date.now() - startedAt < SHORT_TASK_MS) return;
      // The offline push already alerted for the local desktop; the unread
      // marker in the session list is enough after reopening the app.
      if (catchUp && host === null && getRemotePushStatus() === "active") return;
      const catalog = catalogsRef.current[hostKey(host)];
      const session = catalog?.sessions.find((entry) => entry.id === sessionId);
      const title = host === null
        ? session?.title ?? ""
        : `${catalog?.label || host} · ${session?.title || "当前会话"}`;
      if (mobile) {
        const viewing = optionsRef.current.isViewing?.(host, sessionId) ?? false;
        void notifyMobileTask(kind, title, { host, sessionId }, viewing, isRemotePushCovering(host));
      } else if (kind !== "attention") {
        // Desktop approval/question reminders come from useAttentionNotifications,
        // which carries the request detail and per-kind preferences.
        void notifyTaskResult(kind, title);
      }
    };

    const receive = (host: string | null, event: DaemonEvent) => {
      if (event.type === "session_deleted") {
        const key = scopedKey(host, event.sessionId);
        seen.delete(key); started.delete(key); waiting.delete(key); known.delete(key); caughtUp.delete(key);
        return;
      }
      if (event.type === "session_status_changed") {
        const key = scopedKey(host, event.sessionId);
        known.set(key, event.status);
        if (event.status === "running") {
          caughtUp.delete(key);
          if (!started.has(key)) started.set(key, Date.now());
        }
        // A session leaving waiting_approval may prompt again later.
        if (event.status !== "waiting_approval") waiting.delete(key);
      }
      const kind = kindOf(event);
      if (!kind || !("sessionId" in event)) return;
      const sessionId = event.sessionId;
      const key = scopedKey(host, sessionId);
      const cursor = event.eventCursor;
      if (cursor) {
        const previous = seen.get(key);
        if (previous?.epoch === cursor.epoch && previous.sequence >= cursor.sequence) return;
        // Record before delivery: replays must not notify later for an event
        // already received in the foreground or with notifications disabled.
        seen.set(key, cursor);
      }
      if (kind !== "attention") void badge.recordTurnEnd();
      if (kind === "attention") {
        if (waiting.has(key)) return;
        waiting.add(key);
      }
      const startedAt = started.get(key);
      if (kind !== "attention") {
        started.delete(key);
        if (caughtUp.delete(key)) return;
      }
      deliver(host, sessionId, kind, startedAt, false);
    };

    /**
     * Reconnect catch-up. Events emitted while the socket was down are not
     * replayed to the phone, but the refreshed catalog shows the new status.
     * Live events update `known` first, so only missed transitions differ.
     */
    reconcileRef.current = (catalogs) => {
      const now = Date.now();
      for (const catalog of Object.values(catalogs)) {
        const host = catalog.hostId ?? null;
        const hkey = hostKey(host);
        const connected = catalog.state === "connected";
        const wasConnected = hostConnected.get(hkey);
        hostConnected.set(hkey, connected);
        if (!connected) continue;
        // The first connection is a baseline, not a catch-up.
        if (wasConnected === false) catchUpUntil.set(hkey, now + CATCH_UP_WINDOW_MS);
        const catchingUp = now < Math.max(catchUpUntil.get(hkey) ?? 0, allCatchUpUntil);
        for (const session of catalog.sessions) {
          const key = scopedKey(host, session.id);
          const previous = known.get(key);
          known.set(key, session.status);
          if (session.status !== "waiting_approval") waiting.delete(key);
          if (previous === undefined || !catchingUp) continue;
          const kind = missedKind(previous, session.status);
          if (!kind) continue;
          if (kind === "attention") {
            if (waiting.has(key)) continue;
            waiting.add(key);
          } else {
            caughtUp.add(key);
          }
          const startedAt = started.get(key);
          if (kind !== "attention") started.delete(key);
          deliver(host, session.id, kind, startedAt, true);
        }
      }
    };
    reconcileRef.current(catalogsRef.current);

    const offLocal = root.onEvent((event) => receive(null, event));
    const offHost = root.onHostEvent((event) => {
      if (event.type !== "host_event") return;
      if (event.event.type === "remote_resync") catchUpUntil.set(hostKey(event.hostId), Date.now() + CATCH_UP_WINDOW_MS);
      else receive(event.hostId, event.event);
    });
    // The desktop restarted or the relay room changed: every host may have moved on.
    const offResync = root.onResync?.(() => { allCatchUpUntil = Date.now() + CATCH_UP_WINDOW_MS; });
    return () => {
      offLocal(); offHost(); offResync?.(); offFocus(); badge.clear();
      reconcileRef.current = () => undefined;
    };
  }, [root]);

  useEffect(() => { reconcileRef.current(catalogs); }, [catalogs]);

  useEffect(() => {
    if (!isNativeMobileApp()) return;
    let disposed = false;
    let remove: (() => void) | null = null;
    void import("@capacitor/local-notifications").then(async ({ LocalNotifications }) => {
      const handle = await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
        const target = action.notification.extra?.miniqTarget as TaskNotificationTarget | undefined;
        if (!target || typeof target.sessionId !== "string") return;
        const decision = decisionOf(action.actionId);
        const done = decision && target.host === null
          ? resolveFromNotification(root, target.sessionId, undefined, decision)
          : Promise.resolve(false);
        void done.then(() => optionsRef.current.open?.(target));
      });
      if (disposed) void handle.remove();
      else remove = () => { void handle.remove(); };
    }).catch(() => undefined);
    return () => { disposed = true; remove?.(); };
  }, [root]);

  // Offline push: registration, foreground reporting and tapped pushes.
  useEffect(() => startAppBadge(), []);
  useEffect(() => startRemotePush(root, (target) => optionsRef.current.open?.(target)), [root]);
}
