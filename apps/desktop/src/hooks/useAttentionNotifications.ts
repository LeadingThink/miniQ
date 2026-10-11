import { useEffect, useRef } from "react";
import type { RpcClient } from "../rpc";
import type { DaemonEvent } from "../types";
import { hostKey, scopedKey, type HostCatalog, type HostNavigation } from "../hostWorkspace";
import { notifyAttention, type AttentionKind } from "../taskNotifications";
import { isTauriRuntime } from "../runtime";
import { isNativeMobileApp } from "../mobileRuntime";
import { recordAttentionItem } from "../companionInbox";

export type AttentionNavigate = (host: string | null, navigation: HostNavigation) => void;

interface Target { key: string; host: string | null; navigation: HostNavigation }

/**
 * Notifies a backgrounded user when a session waits on an approval or a
 * question. Each request id notifies at most once, even across replays.
 *
 * Native desktop notifications cannot carry a click callback, so when
 * `focusFallback` is on, the first window focus after a notification opens the
 * session of the most recent still-unresolved request.
 */
export function useAttentionNotifications(
  root: RpcClient,
  catalogs: Record<string, HostCatalog>,
  navigate: AttentionNavigate,
  focusFallback: boolean = isTauriRuntime(),
) {
  const catalogsRef = useRef(catalogs);
  catalogsRef.current = catalogs;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const mobile = isNativeMobileApp();
    const notified = new Set<string>();
    const open = new Set<string>();
    let pendingFocus: Target | null = null;
    const go = (target: Target) => {
      pendingFocus = null;
      if (open.has(target.key)) navigateRef.current(target.host, target.navigation);
    };
    const resolve = (key: string) => {
      open.delete(key);
      if (pendingFocus?.key === key) pendingFocus = null;
    };
    const request = (host: string | null, sessionId: string, id: string, kind: AttentionKind, detail: string) => {
      const key = scopedKey(host, `${kind}:${id}`);
      if (notified.has(key)) return;
      // Record before delivery so replays never notify twice.
      notified.add(key);
      open.add(key);
      const catalog = catalogsRef.current[hostKey(host)];
      const session = catalog?.sessions.find((entry) => entry.id === sessionId);
      const title = host === null
        ? session?.title ?? ""
        : `${catalog?.label || host} · ${session?.title || "当前会话"}`;
      const target: Target = { key, host, navigation: { workspaceId: session?.workspaceId ?? null, sessionId } };
      recordAttentionItem({
        host,
        ...(root.targetDeviceId ? { targetDeviceId: root.targetDeviceId } : {}),
        sessionId,
        ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}),
        kind,
        eventKey: `${kind}:${id}`,
        title: session?.title ?? "当前会话",
        detail,
      });
      // Phones receive the native notification path; the inbox still records the event.
      if (mobile) return;
      void notifyAttention(kind, title, detail, () => go(target), { host, sessionId }, id).then((sent) => {
        if (sent && focusFallback && open.has(key)) pendingFocus = target;
      }).catch(() => undefined);
    };
    const receive = (host: string | null, event: DaemonEvent) => {
      switch (event.type) {
        case "approval_requested":
          if (event.approval.status === "pending") request(host, event.sessionId, event.approval.id, "approval", event.approval.reason);
          else resolve(scopedKey(host, `approval:${event.approval.id}`));
          return;
        case "approval_resolved":
          resolve(scopedKey(host, `approval:${event.approval.id}`));
          return;
        case "question_requested":
          request(host, event.sessionId, event.question.id, "question", event.question.prompt);
          return;
        case "question_resolved":
          resolve(scopedKey(host, `question:${event.questionId}`));
          return;
        default:
      }
    };
    const onFocus = () => { if (pendingFocus) go(pendingFocus); };
    window.addEventListener("focus", onFocus);
    const offLocal = root.onEvent((event) => receive(null, event));
    const offHost = root.onHostEvent((event) => {
      if (event.type === "host_event" && event.event.type !== "remote_resync") receive(event.hostId, event.event);
    });
    return () => { offLocal(); offHost(); window.removeEventListener("focus", onFocus); };
  }, [root, focusFallback]);
}
