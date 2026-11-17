import { Sidebar, type SidebarHostGroup } from "./Sidebar";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { isMobileLayout } from "../mobileViewport";
import type { ComponentProps } from "react";

export function AppSidebar({ app, hostGroups, onCreateSession, conversationItems, conversationCounts, onNavigate }: {
  app: MiniqAppController;
  hostGroups?: SidebarHostGroup[];
  onCreateSession?: (key: string) => void;
  conversationItems?: ComponentProps<typeof Sidebar>["conversationItems"];
  conversationCounts?: ComponentProps<typeof Sidebar>["conversationCounts"];
  onNavigate?: () => void;
}) {
  const closeMobileSidebar = () => { if (isMobileLayout()) app.navigation.setSidebarCollapsed(true); };
  return <>
      <Sidebar
        conversationItems={conversationItems}
        conversationCounts={conversationCounts}
        hostGroups={hostGroups}
        onClose={closeMobileSidebar}
        workspaces={app.catalog.workspaces}
        sessions={app.catalog.sessions}
        unreadSessionIds={app.unreadSessionIds}
        currentSessionId={app.catalog.currentSessionId}
        selectedWorkspaceId={app.catalog.selectedWorkspace?.id ?? null}
        onNewChat={() => {
          onNavigate?.();
          app.actions.newChat();
          closeMobileSidebar();
        }}
        onShowSearch={() => {
          onNavigate?.();
          app.navigation.setShowSearch(true);
          closeMobileSidebar();
        }}
        onShowSchedule={() => {
          onNavigate?.();
          app.navigation.setPage("schedule");
          closeMobileSidebar();
        }}
        onImportSessions={() => {
          onNavigate?.();
          app.navigation.setShowExternalImport(true);
          closeMobileSidebar();
        }}
        onSelectWorkspace={(workspaceId) => {
          onNavigate?.();
          // Expanding a project is navigation within the drawer, not leaving it.
          app.actions.selectWorkspace(workspaceId);
        }}
        extensionsActive={app.navigation.page === "skills" || app.navigation.page === "mcp" || app.navigation.page === "plugins"}
        onShowSkills={() => {
          onNavigate?.();
          app.navigation.setPage("skills");
          closeMobileSidebar();
        }}
        onCreateSession={(workspaceId) => {
          onNavigate?.();
          if (onCreateSession) onCreateSession(workspaceId);
          else void app.actions.createSession(workspaceId).catch((cause) => app.setError(cause instanceof Error ? cause.message : String(cause)));
          closeMobileSidebar();
        }}
        onDeleteWorkspace={(workspaceId) =>
          void app.actions.deleteWorkspace(workspaceId)
        }
        onRenameWorkspace={(workspaceId, name) =>
          void app.actions.renameWorkspace(workspaceId, name)
        }
        onEditWorkspace={(id) => { onNavigate?.(); app.navigation.setEditingWorkspaceId(id); }}
        onSelectSession={(sessionId) => {
          onNavigate?.();
          closeMobileSidebar();
          void app.actions.openSession(sessionId);
        }}
        onSessionSeen={app.markSessionSeen}
        onSessionUnread={app.markSessionUnread}
        onMarkAllRead={app.markAllSessionsRead}
        onDeleteSession={(sessionId) =>
          void app.actions.deleteSession(sessionId)
        }
        onDeleteSessionStart={() => { onNavigate?.(); app.actions.newChat(); }}
        onDeleteSessionUndo={(sessionId) => { onNavigate?.(); void app.actions.openSession(sessionId); }}
        onRenameSession={(sessionId, title) =>
          void app.actions.renameSession(sessionId, title)
        }
        onSetSessionPinned={(sessionId, pinned) =>
          void app.actions.setSessionPinned(sessionId, pinned)
        }
        onSetSessionArchived={(sessionId, archived) =>
          void app.actions.setSessionArchived(sessionId, archived)
        }
        onShowSettings={() => {
          onNavigate?.();
          app.navigation.setShowSettings(true);
          closeMobileSidebar();
        }}
        updateSupported={app.updater.supported}
        updateState={app.updater.state}
        onCheckForUpdates={() => void app.updater.checkNow()}
        onInstallUpdate={() => void app.updater.install()}
        onError={app.setError}
      />
      {!app.navigation.sidebarCollapsed && (
        <button
          type="button"
          className="mobile-sidebar-scrim"
          aria-label="关闭侧栏"
          onClick={() => app.navigation.setSidebarCollapsed(true)}
        />
      )}
  </>;
}
