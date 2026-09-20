import { Sidebar, type SidebarHostGroup } from "./Sidebar";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { isMobileLayout } from "../mobileViewport";

export function AppSidebar({ app, hostGroups, onCreateSession }: { app: MiniqAppController; hostGroups?: SidebarHostGroup[]; onCreateSession?: (key: string) => void }) {
  const closeMobileSidebar = () => { if (isMobileLayout()) app.navigation.setSidebarCollapsed(true); };
  return <>
      <Sidebar
        hostGroups={hostGroups}
        workspaces={app.catalog.workspaces}
        sessions={app.catalog.sessions}
        unreadSessionIds={app.unreadSessionIds}
        currentSessionId={app.catalog.currentSessionId}
        selectedWorkspaceId={app.catalog.selectedWorkspace?.id ?? null}
        onNewChat={() => {
          app.actions.newChat();
          closeMobileSidebar();
        }}
        onShowSearch={() => {
          app.navigation.setShowSearch(true);
          closeMobileSidebar();
        }}
        onShowSchedule={() => {
          app.navigation.setPage("schedule");
          closeMobileSidebar();
        }}
        onImportSessions={() => {
          app.navigation.setShowExternalImport(true);
          closeMobileSidebar();
        }}
        onSelectWorkspace={(workspaceId) => {
          app.actions.selectWorkspace(workspaceId);
          closeMobileSidebar();
        }}
        onCreateSession={onCreateSession ?? ((workspaceId) =>
          void app.actions.createSession(workspaceId).catch((cause) => app.setError(cause instanceof Error ? cause.message : String(cause)))
        )}
        onDeleteWorkspace={(workspaceId) =>
          void app.actions.deleteWorkspace(workspaceId)
        }
        onRenameWorkspace={(workspaceId, name) =>
          void app.actions.renameWorkspace(workspaceId, name)
        }
        onEditWorkspace={app.navigation.setEditingWorkspaceId}
        onSelectSession={(sessionId) => {
          closeMobileSidebar();
          void app.actions.openSession(sessionId);
        }}
        onSessionSeen={app.markSessionSeen}
        onDeleteSession={(sessionId) =>
          void app.actions.deleteSession(sessionId)
        }
        onRenameSession={(sessionId, title) =>
          void app.actions.renameSession(sessionId, title)
        }
        onSetSessionPinned={(sessionId, pinned) =>
          void app.actions.setSessionPinned(sessionId, pinned)
        }
        onSetSessionArchived={(sessionId, archived) =>
          void app.actions.setSessionArchived(sessionId, archived)
        }
        onShowSkills={() => {
          app.navigation.setPage("skills");
          closeMobileSidebar();
        }}
        onShowMcp={() => {
          app.navigation.setPage("mcp");
          closeMobileSidebar();
        }}
        onShowPlugins={() => {
          app.navigation.setPage("plugins");
          closeMobileSidebar();
        }}
        onShowSettings={() => {
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
