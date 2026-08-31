import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { ThemeId } from "../theme";
import { errorMessage } from "../errorMessage";
import {
  isTextPreviewFile,
  revealLocalFile,
  type LocalFileTarget,
} from "../localFiles";
import { FileDiff } from "lucide-react";
import { lazy, Suspense } from "react";
import { Composer, ComposerCard } from "./Composer";
import { DistillModal } from "./Distill";
import { ExternalSessionImportDialog } from "./ExternalSessionImport";
import { McpPanel } from "./Mcp";
import { ProjectPicker } from "./ProjectPicker";
import { ReviewPanel } from "./ReviewPanel";
import { SchedulePanel } from "./Schedule";
import { SearchOverlay } from "./Search";
import { SettingsPanel } from "./Settings";
import { Sidebar } from "./Sidebar";
import { SkillsPanel } from "./Skills";
import { Timeline } from "./Timeline";

interface AppOnlyProps {
  app: MiniqAppController;
}

interface AppShellProps extends AppOnlyProps {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}

const FilePreviewPanel = lazy(async () => {
  const module = await import("./FilePreviewPanel");
  return { default: module.FilePreviewPanel };
});

function openFileTarget(app: MiniqAppController, target: LocalFileTarget) {
  if (isTextPreviewFile(target.path)) {
    app.review.setOpen(false);
    void app.preview.openFile(target);
    return;
  }

  app.setError(null);
  void revealLocalFile(target.path, app.catalog.currentWorkspace?.path).catch(
    (cause) => app.setError(errorMessage(cause)),
  );
}

function StatusBar({ app }: AppOnlyProps) {
  const { connected, health } = app.connection;
  const currentSession = app.catalog.currentSession;
  const canDistill =
    currentSession &&
    !app.busy &&
    app.feed.messages.some((message) => message.role === "assistant");

  return (
    <div className="statusbar">
      <span className={`dot ${connected ? "ok" : "bad"}`} />
      <span>{connected ? `daemon v${health?.daemonVersion ?? "?"}` : "未连接"}</span>
      {currentSession && (
        <span className={`badge ${currentSession.status}`}>
          {currentSession.status}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {app.review.data.files.length > 0 && (
        <button
          className="ghost review-toggle"
          title="查看本会话的代码修改"
          onClick={() => {
            app.preview.close();
            app.review.setOpen(!app.review.open);
          }}
        >
          <FileDiff size={16} />
          审阅 {app.review.data.files.length}
          <span className="diff-add">+{app.review.data.additions}</span>
          <span className="diff-delete">-{app.review.data.deletions}</span>
        </button>
      )}
      {canDistill && (
        <button
          className="ghost"
          onClick={() => app.navigation.setShowDistill(true)}
        >
          ✦ 保存为技能
        </button>
      )}
    </div>
  );
}

function ErrorBanner({ app }: AppOnlyProps) {
  if (!app.error) return null;
  return (
    <div className="error-banner">
      <span style={{ flex: 1 }}>{app.error}</span>
      <span className="banner-close" onClick={() => app.setError(null)}>
        ✕
      </span>
    </div>
  );
}

function AppOverlays({ app, theme, onThemeChange }: AppShellProps) {
  return (
    <>
      {app.navigation.showSettings && (
        <SettingsPanel
          client={app.client}
          theme={theme}
          onThemeChange={onThemeChange}
          onClose={() => app.navigation.setShowSettings(false)}
        />
      )}
      {app.navigation.showSearch && (
        <SearchOverlay
          sessions={app.catalog.sessions}
          workspaces={app.catalog.workspaces}
          onSelectSession={(sessionId) => void app.actions.openSession(sessionId)}
          onClose={() => app.navigation.setShowSearch(false)}
        />
      )}
      {app.navigation.showDistill && app.catalog.currentSessionId && (
        <DistillModal
          client={app.client}
          sessionId={app.catalog.currentSessionId}
          onClose={() => app.navigation.setShowDistill(false)}
        />
      )}
      {app.navigation.showExternalImport && (
        <ExternalSessionImportDialog
          client={app.client}
          workspaces={app.catalog.workspaces}
          onClose={() => app.navigation.setShowExternalImport(false)}
          onImported={async () => {
            await Promise.all([
              app.catalog.refreshWorkspaces(),
              app.catalog.refreshSessions(),
            ]);
          }}
          onOpenSession={app.actions.openSession}
        />
      )}
    </>
  );
}

function SessionPage({ app }: AppOnlyProps) {
  return (
    <>
      <Timeline
        messages={app.feed.messages}
        toolCalls={app.feed.toolCalls}
        approvals={app.feed.approvals}
        questions={app.feed.questions}
        plan={app.feed.plan}
        artifacts={app.feed.artifacts}
        workspacePath={app.catalog.currentWorkspace?.path}
        streamingText={app.feed.streamingText}
        busy={!!app.busy}
        onResolveApproval={app.actions.resolveApproval}
        onResolveQuestion={app.actions.resolveQuestion}
        onRollback={app.actions.rollbackCheckpoint}
        onOpenFile={(target) => openFileTarget(app, target)}
      />
      <Composer
        busy={!!app.busy}
        chip={app.catalog.currentWorkspace?.name}
        approvalMode={app.connection.approvalMode}
        onApprovalModeChange={app.connection.changeApprovalMode}
        onSend={app.actions.sendMessage}
        onCancel={app.actions.cancelTurn}
      />
    </>
  );
}

function HeroPage({ app }: AppOnlyProps) {
  const selectedWorkspace = app.catalog.selectedWorkspace;
  return (
    <div className="hero">
      <h1>
        {selectedWorkspace
          ? `要在 ${selectedWorkspace.name} 中完成什么?`
          : "今天想完成什么?"}
      </h1>
      <div className="hero-composer">
        <ComposerCard
          busy={false}
          autoFocus
          placeholder={
            selectedWorkspace
              ? "描述你的目标,例如:整理这份资料并生成周报"
              : "先选择一个项目,再描述你的目标"
          }
          chipSlot={
            <ProjectPicker
              workspaces={app.catalog.workspaces}
              selectedId={selectedWorkspace?.id ?? null}
              onSelect={app.actions.selectProject}
              onCreateBlank={(name) => void app.actions.createBlankProject(name)}
              onOpenFolder={() => void app.actions.openWorkspace()}
            />
          }
          approvalMode={app.connection.approvalMode}
          onApprovalModeChange={app.connection.changeApprovalMode}
          onSend={app.actions.startTask}
        />
      </div>
      <div className="hero-cards">
        <div className="hero-card" onClick={() => app.navigation.setPage("skills")}>
          <div className="hero-card-title">✦ 技能</div>
          <div className="hero-card-sub">查看可复用的工作流,或从任务中学习新技能</div>
        </div>
        <div className="hero-card" onClick={() => app.navigation.setPage("mcp")}>
          <div className="hero-card-title">🔌 连接 MCP</div>
          <div className="hero-card-sub">接入外部工具与服务,扩展 agent 能力</div>
        </div>
      </div>
    </div>
  );
}

function MainPage({ app }: AppOnlyProps) {
  switch (app.navigation.page) {
    case "schedule":
      return (
        <SchedulePanel
          client={app.client}
          workspaces={app.catalog.workspaces}
          defaultWorkspaceId={app.catalog.selectedWorkspace?.id ?? null}
          onClose={() => app.navigation.setPage(null)}
          onOpenSession={(sessionId) => void app.actions.openSession(sessionId)}
        />
      );
    case "skills":
      return (
        <SkillsPanel
          client={app.client}
          workspaceId={app.catalog.selectedWorkspace?.id ?? null}
        />
      );
    case "mcp":
      return <McpPanel client={app.client} />;
    default:
      return app.catalog.currentSessionId ? (
        <SessionPage app={app} />
      ) : (
        <HeroPage app={app} />
      );
  }
}

export function AppShell({ app, theme, onThemeChange }: AppShellProps) {
  return (
    <div className="app">
      <Sidebar
        workspaces={app.catalog.workspaces}
        sessions={app.catalog.sessions}
        currentSessionId={app.catalog.currentSessionId}
        selectedWorkspaceId={app.catalog.selectedWorkspace?.id ?? null}
        onNewChat={app.actions.newChat}
        onShowSearch={() => app.navigation.setShowSearch(true)}
        onShowSchedule={() => app.navigation.setPage("schedule")}
        onImportSessions={() => app.navigation.setShowExternalImport(true)}
        onSelectWorkspace={app.actions.selectWorkspace}
        onCreateSession={(workspaceId) => void app.actions.createSession(workspaceId)}
        onDeleteWorkspace={(workspaceId) => void app.actions.deleteWorkspace(workspaceId)}
        onRenameWorkspace={(workspaceId, name) => void app.actions.renameWorkspace(workspaceId, name)}
        onSelectSession={(sessionId) => void app.actions.openSession(sessionId)}
        onDeleteSession={(sessionId) => void app.actions.deleteSession(sessionId)}
        onRenameSession={(sessionId, title) => void app.actions.renameSession(sessionId, title)}
        onSetSessionPinned={(sessionId, pinned) => void app.actions.setSessionPinned(sessionId, pinned)}
        onShowSkills={() => app.navigation.setPage("skills")}
        onShowMcp={() => app.navigation.setPage("mcp")}
        onShowSettings={() => app.navigation.setShowSettings(true)}
        updateSupported={app.updater.supported}
        updateState={app.updater.state}
        onCheckForUpdates={() => void app.updater.checkNow()}
        onInstallUpdate={() => void app.updater.install()}
      />
      <div className="main">
        <StatusBar app={app} />
        <ErrorBanner app={app} />
        <AppOverlays app={app} theme={theme} onThemeChange={onThemeChange} />
        <MainPage app={app} />
      </div>
      {app.preview.state.open && app.catalog.currentWorkspace ? (
        <Suspense
          fallback={
            <aside className="file-preview-panel">
              <div className="diff-empty">正在加载编辑器...</div>
            </aside>
          }
        >
          <FilePreviewPanel
            preview={app.preview.state}
            workspacePath={app.catalog.currentWorkspace.path}
            onClose={app.preview.close}
          />
        </Suspense>
      ) : app.review.open && app.catalog.currentWorkspace ? (
        <ReviewPanel
          diff={app.review.data}
          onOpenFile={(target) => openFileTarget(app, target)}
          onClose={() => app.review.setOpen(false)}
        />
      ) : null}
    </div>
  );
}
