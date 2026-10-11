import { useEffect, useMemo, useState } from "react";
import { subscribe } from "../companionInbox";
import { getLocalAttentionItems, localCompanionNotices, markLocalNoticeRead } from "../companionInboxAdapter";
import type { Session, Workspace } from "../types";

/** Storage events synchronize the separate main/companion webviews on the same app origin. */
export function useCompanionInbox(workspaces: readonly Workspace[], sessions: readonly Session[]) {
  const [items, setItems] = useState(getLocalAttentionItems);
  useEffect(() => {
    const refresh = () => setItems(getLocalAttentionItems());
    const off = subscribe(refresh);
    refresh(); // Include changes between the render snapshot and subscription.
    // WebKit does not always deliver storage events between native windows.
    const timer = window.setInterval(refresh, 1500);
    window.addEventListener("focus", refresh);
    return () => { off(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const notices = useMemo(() => localCompanionNotices(items, workspaces, sessions), [items, workspaces, sessions]);
  return { notices, onNoticeOpened: markLocalNoticeRead };
}
