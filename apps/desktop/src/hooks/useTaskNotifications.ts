import { useEffect, useRef } from "react";
import type { RpcClient } from "../rpc";
import type { DaemonEvent, EventCursor } from "../types";
import { hostKey, scopedKey, type HostCatalog } from "../hostWorkspace";
import { notifyTaskResult } from "../taskNotifications";

/** One subscription at the desktop root covers every host, including hidden ones. */
export function useTaskNotifications(root: RpcClient, catalogs: Record<string, HostCatalog>) {
  const catalogsRef = useRef(catalogs);
  catalogsRef.current = catalogs;

  useEffect(() => {
    const seen = new Map<string, EventCursor>();
    const receive = (host: string | null, event: DaemonEvent) => {
      if (event.type === "session_deleted") {
        seen.delete(scopedKey(host, event.sessionId));
        return;
      }
      if (event.type !== "turn_completed" && event.type !== "turn_failed") return;
      const key = scopedKey(host, event.sessionId);
      const cursor = event.eventCursor;
      if (cursor) {
        const previous = seen.get(key);
        if (previous?.epoch === cursor.epoch && previous.sequence >= cursor.sequence) return;
        // Record before delivery: replays must not notify later for an event
        // already received in the foreground or with notifications disabled.
        seen.set(key, cursor);
      }
      const catalog = catalogsRef.current[hostKey(host)];
      const session = catalog?.sessions.find((entry) => entry.id === event.sessionId);
      const title = host === null
        ? session?.title ?? ""
        : `${catalog?.label || host} · ${session?.title || "当前会话"}`;
      void notifyTaskResult(event.type === "turn_completed" ? "completed" : "failed", title);
    };
    const offLocal = root.onEvent((event) => receive(null, event));
    const offHost = root.onHostEvent((event) => {
      if (event.type === "host_event" && event.event.type !== "remote_resync") receive(event.hostId, event.event);
    });
    return () => { offLocal(); offHost(); };
  }, [root]);
}
