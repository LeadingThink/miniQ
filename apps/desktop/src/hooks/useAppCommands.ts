import { useCallback, useEffect, useRef, useState } from "react";
import type { MiniqAppController } from "./useMiniqApp";
import { showUndoToast, useToast } from "../components/ui/Toast";
import {
  COMMAND_EVENT,
  isCommandId,
  type CommandEventDetail,
  type CommandId,
  type ShortcutMatch,
} from "../shortcuts";
import {
  EMPTY_HISTORY,
  moveHistory,
  nextAttentionSession,
  recentSession,
  sidebarSessionOrder,
  stepSession,
  visitSession,
  type SessionHistory,
} from "../sessionNavigation";
import { readExportHistory } from "../historyExport";
import { exportMarkdown } from "../sessionExport";
import { errorMessage } from "../errorMessage";

/** Focus the visible in-session search box (⌘F). Returns false when absent. */
export function focusSessionSearch(): boolean {
  const search = document.querySelector<HTMLInputElement>(
    '.main[data-app-active="true"] input[data-session-search="true"]',
  );
  if (!search) return false;
  search.focus();
  search.select();
  return true;
}

/**
 * One command runner shared by the keydown handler, the `miniq:command` bus
 * (native menu accelerators swallow the key events) and the command palette.
 */
export function useAppCommands(app: MiniqAppController, active: boolean) {
  const toast = useToast();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const history = useRef<SessionHistory>(EMPTY_HISTORY);
  const currentSessionId = app.catalog.currentSessionId;

  useEffect(() => {
    if (currentSessionId) history.current = visitSession(history.current, currentSessionId);
  }, [currentSessionId]);

  // Keep the latest controller in a ref so the runner stays stable.
  const latest = useRef(app);
  latest.current = app;

  const runCommand = useCallback((id: CommandId | "openSessionN", index = 0): boolean => {
    const app = latest.current;
    const { catalog, navigation, actions } = app;
    const current = catalog.currentSessionId;
    const live = catalog.sessions.filter((session) => !session.archived);
    const exists = (sessionId: string) => live.some((session) => session.id === sessionId);
    const order = () => sidebarSessionOrder(catalog.workspaces, catalog.sessions, app.unreadSessionIds);
    const open = (target: string | null | undefined) => {
      if (!target) return false;
      void actions.openSession(target);
      return true;
    };
    const currentSession = catalog.currentSession;

    switch (id) {
      case "newChat": actions.newChat(); return true;
      case "settings": navigation.setShowSettings(true); return true;
      case "toggleSidebar": navigation.setSidebarCollapsed(!navigation.sidebarCollapsed); return true;
      case "palette": navigation.setShowSearch(!navigation.showSearch); return true;
      case "find": return focusSessionSearch();
      case "showShortcuts": setShowShortcuts((open) => !open); return true;
      case "prevSession": return open(stepSession(order(), current, -1));
      case "nextSession": return open(stepSession(order(), current, 1));
      case "openSessionN": return open(order()[index]);
      case "prevRecentSession": return open(recentSession(history.current, current, -1, exists));
      case "nextRecentSession": return open(recentSession(history.current, current, 1, exists));
      case "nextAttention":
        return open(nextAttentionSession(order(), current, catalog.sessions, app.unreadSessionIds));
      case "back":
      case "forward": {
        const moved = moveHistory(history.current, id === "back" ? -1 : 1, exists);
        if (!moved) return false;
        history.current = moved.history;
        return open(moved.target);
      }
      case "archiveSession": {
        if (!currentSession || currentSession.archived) return false;
        const sessionId = currentSession.id;
        void actions.setSessionArchived(sessionId, true);
        showUndoToast(toast, {
          message: `已归档会话“${currentSession.title}”`,
          onCommit: () => {},
          onUndo: () => {
            void actions.setSessionArchived(sessionId, false).then(() => actions.openSession(sessionId));
          },
        });
        return true;
      }
      case "togglePin":
        if (!currentSession) return false;
        void actions.setSessionPinned(currentSession.id, !currentSession.pinned);
        return true;
      case "markUnread":
        if (!current) return false;
        app.markSessionUnread(current);
        toast.show({ message: "已标为未读" });
        return true;
      case "markAllRead": app.markAllSessionsRead(); return true;
      case "copyMarkdown": {
        if (!current) return false;
        const title = currentSession?.title ?? "miniQ session";
        const controller = new AbortController();
        void readExportHistory(app.client, current, controller.signal)
          .then((history) => navigator.clipboard.writeText(exportMarkdown({
            title,
            ...history,
            plan: app.feed.plan,
            artifacts: app.feed.artifacts,
          })))
          .then(() => toast.show({ message: "已复制为 Markdown" }))
          .catch((cause) => app.setError(`复制失败: ${errorMessage(cause)}`));
        return true;
      }
    }
    return false;
  }, [toast]);

  const onShortcut = useCallback(
    (match: ShortcutMatch) => (match.id === "openSessionN" ? runCommand("openSessionN", match.index) : runCommand(match.id)),
    [runCommand],
  );

  useEffect(() => {
    if (!active) return;
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<CommandEventDetail>).detail;
      if (isCommandId(detail?.id)) runCommand(detail.id);
    };
    // Mouse side buttons: 3 = back, 4 = forward.
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      runCommand(event.button === 3 ? "back" : "forward");
    };
    window.addEventListener(COMMAND_EVENT, onCommand);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener(COMMAND_EVENT, onCommand);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [active, runCommand]);

  return { runCommand, onShortcut, showShortcuts, setShowShortcuts };
}
