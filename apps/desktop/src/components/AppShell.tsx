import type { MiniqAppController } from "../hooks/useMiniqApp";
import { Composer, ComposerCard } from "./Composer";
import { DistillModal } from "./Distill";
import { ExternalSessionImportDialog } from "./ExternalSessionImport";
import { McpPanel } from "./Mcp";
import { ProjectPicker } from "./ProjectPicker";
import { SchedulePanel } from "./Schedule";
import { SearchOverlay } from "./Search";
import { SettingsPanel } from "./Settings";
import { Sidebar } from "./Sidebar";
import { SkillsPanel } from "./Skills";
import { Timeline } from "./Timeline";

interface AppShellProps {
  app: MiniqAppController;
}

function StatusBar({ app }: AppShellProps) {
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

function ErrorBanner({ app }: AppShellProps) {
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

function AppOverlays({ app }: AppShellProps) {
  return (
    <>
      {app.navigation.showSettings && (
        <SettingsPanel
          client={app.client}
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

function SessionPage({ app }: AppShellProps) {
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

function HeroPage({ app }: AppShellProps) {
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

function MainPage({ app }: AppShellProps) {
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

export function AppShell({ app }: AppShellProps) {
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
        onSelectSession={(sessionId) => void app.actions.openSession(sessionId)}
        onShowSkills={() => app.navigation.setPage("skills")}
        onShowMcp={() => app.navigation.setPage("mcp")}
        onShowSettings={() => app.navigation.setShowSettings(true)}
        updateState={app.updater.state}
        onCheckForUpdates={() => void app.updater.checkNow()}
        onInstallUpdate={() => void app.updater.install()}
      />
      <div className="main">
        <StatusBar app={app} />
        <ErrorBanner app={app} />
        <AppOverlays app={app} />
        <MainPage app={app} />
      </div>
    </div>
  );
}
