import type { MiniqAppController } from "../hooks/useMiniqApp";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import type { ThemeId } from "../theme";
import { type LocalFileTarget } from "../localFiles";
import { LoaderCircle, PlugZap, Sparkles } from "lucide-react";
import { Fragment, lazy, Suspense, useState } from "react";
import { Composer, ComposerCard } from "./Composer";
import type { ComposerSlashCommand } from "../composerSlash";
import { useAppSlashCommands } from "../hooks/useAppSlashCommands";
import { DistillModal } from "./Distill";
import { ExternalSessionImportDialog } from "./ExternalSessionImport";
import { McpPanel } from "./Mcp";
import { PluginsPanel } from "./Plugins";
import { ProjectPicker } from "./ProjectPicker";
import { SchedulePanel } from "./Schedule";
import { SearchOverlay, type PaletteCommand } from "./Search";
import { SettingsPanel } from "./Settings";
import { AppSidebar } from "./AppSidebar";
import { SkillsPanel } from "./Skills";
import { StarterPrompts } from "./StarterPrompts";
import { AppErrorBanner, AppStatusBar } from "./AppStatus";
import { SessionModelControls } from "./SessionModelControls";
import { SessionPermissionControls } from "./SessionPermissionControls";
import { AgentPanel } from "./AgentPanel";
import { ProjectDirectories } from "./ProjectDirectories";
import { hostDraftKey, useDesktopHost } from "../desktopHost";
import { RemotePathDialog } from "./RemotePathDialog";

import { useAppWorkbench } from "../hooks/useAppWorkbench";
import { AppWorkbench } from "./AppWorkbench";

interface AppOnlyProps {
  app: MiniqAppController;
}

interface AppShellProps extends AppOnlyProps {
  contentOnly?: boolean;
  active?: boolean;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}

const Timeline = lazy(async () => {
  const module = await import("./Timeline");
  return { default: module.Timeline };
});

function AppOverlays({ app, theme, onThemeChange }: AppShellProps) {
  const desktop = useDesktopHost();
  const editingWorkspace = app.catalog.workspaces.find(
    (workspace) => workspace.id === app.navigation.editingWorkspaceId,
  );
  return (
    <>
      {app.navigation.showRemoteFolder && app.client.sshHost && <RemotePathDialog
        host={app.client.sshHost} purpose="project" onSubmit={app.actions.openRemoteWorkspace}
        onClose={() => app.navigation.setShowRemoteFolder(false)} />}
      {editingWorkspace && (
        <ProjectDirectories
          key={editingWorkspace.id}
          workspace={editingWorkspace}
          readOnly={(desktop?.root ?? app.client).mode === "remote"}
          remote={!!app.client.sshHost}
          sessions={app.catalog.sessions.filter(
            (session) => session.workspaceId === editingWorkspace.id,
          )}
          onClose={() => app.navigation.setEditingWorkspaceId(null)}
          onSave={async (paths) => {
            await app.client.call("workspace.updateRoots", {
              workspaceId: editingWorkspace.id,
              paths,
            });
            await app.catalog.refreshWorkspaces();
          }}
        />
      )}
      {app.navigation.showSettings && (
        <SettingsPanel
          client={app.client}
          theme={theme}
          onThemeChange={onThemeChange}
          onProviderConfigured={() => void app.connection.refreshProviderConfiguration()}
          onClose={() => app.navigation.setShowSettings(false)}
        />
      )}
      {app.navigation.showSearch && (
        <SearchOverlay
          sessions={app.catalog.sessions}
          workspaces={app.catalog.workspaces}
          commands={buildPaletteCommands(app)}
          client={app.client}
          onSelectSession={(sessionId) =>
            void app.actions.openSession(sessionId)
          }
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

interface WorkbenchPageProps extends AppOnlyProps {
  slashCommands: ComposerSlashCommand[];
  onOpenFile: (target: LocalFileTarget) => void;
  onOpenUrl: (url: string) => void;
  draftRequest?: { id: number; content: string; append?: boolean };
  onDraftRequestApplied?: () => void;
}

function SessionPage({ app, slashCommands, onOpenFile, onOpenUrl, draftRequest, onDraftRequestApplied }: WorkbenchPageProps) {
  return (
    <>
      <AgentPanel
        client={app.client}
        sessionId={app.catalog.currentSessionId!}
        busy={!!app.busy}
      />
      <Suspense
        fallback={
          <div className="timeline-loading">
            <LoaderCircle className="connection-spinner" size={18} />
            正在加载会话
          </div>
        }
      >
        <Timeline
          client={app.client}
          sessionId={app.catalog.currentSessionId!}
          loading={app.feed.loading}
          historyCursor={app.feed.nextCursor}
          loadingOlder={app.actions.loadingOlder}
          onLoadOlder={app.actions.loadOlder}
          title={app.catalog.currentSession?.title}
          messages={app.feed.messages}
          toolCalls={app.feed.toolCalls}
          approvals={app.feed.approvals}
          questions={app.feed.questions}
          plan={app.feed.plan}
          artifacts={app.feed.artifacts}
          queue={app.feed.queue}
          workspacePath={app.catalog.currentSession?.workingDirectory}
          workspacePaths={app.catalog.currentWorkspacePaths}
          streamingText={app.feed.streamingText}
          turnProgress={app.feed.turnProgress}
          latestTurnTiming={app.feed.latestTurnTiming}
          busy={!!app.busy}
          onResolveApproval={app.actions.resolveApproval}
          onResolveQuestion={app.actions.resolveQuestion}
          onRollback={app.actions.rollbackCheckpoint}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
          onSteerQueued={app.actions.steerQueued}
          onRemoveQueued={app.actions.removeQueued}
          onUpdateQueued={app.actions.updateQueued}
          onRewrite={app.actions.rewriteMessage}
          onError={app.setError}
        />
      </Suspense>
      <Composer
        slashCommands={slashCommands}
        workspaceId={app.catalog.currentWorkspace?.id}
        modelSlot={
          <SessionModelControls
            client={app.client}
            model={app.sessionModel}
            busy={!!app.busy}
          />
        }
        sendBlocked={!app.sessionModel.ready || app.sessionModel.pending}
        busy={!!app.busy}
        chip={app.catalog.currentWorkspace?.name}
        draftKey={hostDraftKey(app.client.sshHost, app.catalog.currentSessionId!)}
        draftRequest={draftRequest}
        onDraftRequestApplied={onDraftRequestApplied}
        client={app.client}
        permissionSlot={
          <SessionPermissionControls
            client={app.client}
            sessionId={app.catalog.currentSessionId!}
          />
        }
        onSend={app.actions.sendMessage}
        onCancel={app.actions.cancelTurn}
        onError={app.setError}
      />
    </>
  );
}

function HeroPage({ app, slashCommands }: AppOnlyProps & { slashCommands: ComposerSlashCommand[] }) {
  const selectedWorkspace = app.catalog.selectedWorkspace;
  const [draftRequest, setDraftRequest] = useState<
    { id: number; content: string } | undefined
  >();
  return (
    <div className="hero">
      <h1>
        {selectedWorkspace
          ? `要在 ${selectedWorkspace.name} 中完成什么？`
          : "今天想完成什么？"}
      </h1>
      <div className="hero-composer">
        <ComposerCard
          slashCommands={slashCommands}
          workspaceId={selectedWorkspace?.id}
          modelSlot={
            <SessionModelControls
              client={app.client}
              model={app.sessionModel}
              busy={false}
              placement="below"
            />
          }
          busy={false}
          autoFocus
          draftKey={hostDraftKey(app.client.sshHost, "hero")}
          draftRequest={draftRequest}
          client={app.client}
          placeholder={
            selectedWorkspace
              ? "描述你的目标，例如：整理这份资料并生成周报"
              : "先选择一个项目，再描述你的目标"
          }
          chipSlot={
            <ProjectPicker
              workspaces={app.catalog.workspaces}
              selectedId={selectedWorkspace?.id ?? null}
              onSelect={app.actions.selectProject}
              onCreateBlank={(name) =>
                void app.actions.createBlankProject(name)
              }
              onOpenFolder={() => void app.actions.openWorkspace()}
            />
          }
          approvalMode={app.connection.approvalMode}
          onApprovalModeChange={app.connection.changeApprovalMode}
          onSend={app.actions.startTask}
          onError={app.setError}
          sendBlocked={
            !selectedWorkspace ||
            !app.sessionModel.ready ||
            app.sessionModel.pending
          }
          sendBlockedReason="请先选择项目"
        />
      </div>
      <StarterPrompts
        onSelect={(prompt) =>
          setDraftRequest({ id: Date.now(), content: prompt.prompt })
        }
      />
      <div className="hero-cards">
        <button
          type="button"
          className="hero-card"
          onClick={() => app.navigation.setPage("skills")}
        >
          <div className="hero-card-title">
            <Sparkles size={14} />
            技能
          </div>
          <div className="hero-card-sub">
            查看可复用的工作流,或从任务中学习新技能
          </div>
        </button>
        <button
          type="button"
          className="hero-card"
          onClick={() => app.navigation.setPage("mcp")}
        >
          <div className="hero-card-title">
            <PlugZap size={14} />
            连接 MCP
          </div>
          <div className="hero-card-sub">
            接入外部工具与服务,扩展 agent 能力
          </div>
        </button>
      </div>
    </div>
  );
}

function MainPage({ app, slashCommands, onOpenFile, onOpenUrl, draftRequest, onDraftRequestApplied }: WorkbenchPageProps) {
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
    case "plugins":
      return <PluginsPanel client={app.client} />;
    default:
      return app.catalog.currentSessionId ? (
        <SessionPage
          key={app.catalog.currentSessionId}
          app={app}
          slashCommands={slashCommands}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
          draftRequest={draftRequest}
          onDraftRequestApplied={onDraftRequestApplied}
        />
      ) : (
        <HeroPage app={app} slashCommands={slashCommands} />
      );
  }
}

function buildPaletteCommands(app: MiniqAppController): PaletteCommand[] {
  return [
    {
      id: "new-chat",
      label: "新建会话",
      hint: "⌘N",
      icon: "new",
      run: app.actions.newChat,
    },
    {
      id: "settings",
      label: "打开设置",
      hint: "⌘,",
      icon: "settings",
      run: () => app.navigation.setShowSettings(true),
    },
    {
      id: "skills",
      label: "技能",
      icon: "skills",
      run: () => app.navigation.setPage("skills"),
    },
    {
      id: "mcp",
      label: "MCP 连接",
      icon: "mcp",
      run: () => app.navigation.setPage("mcp"),
    },
    {
      id: "schedule",
      label: "已安排的任务",
      icon: "schedule",
      run: () => app.navigation.setPage("schedule"),
    },
  ];
}

export function AppShell({ app, theme, onThemeChange, contentOnly = false, active = true }: AppShellProps) {
  const workbench = useAppWorkbench(app);
  const [fileQuestion, setFileQuestion] = useState<{ sessionId: string; id: number; content: string; append: boolean }>();
  const slash = useAppSlashCommands(app, {
    onOpenBrowser: () => workbench.select("browser"),
    onOpenReview: () => workbench.select("review"),
  });

  useGlobalShortcuts({
    onPalette: () => app.navigation.setShowSearch(!app.navigation.showSearch),
    onNewChat: app.actions.newChat,
    onSettings: () => app.navigation.setShowSettings(true),
    onStop: app.busy ? () => void app.actions.cancelTurn() : undefined,
    onToggleSidebar: () =>
      app.navigation.setSidebarCollapsed(!app.navigation.sidebarCollapsed),
  }, active);

  const Container = contentOnly ? Fragment : "div";

  return (
    <Container {...(contentOnly ? {} : { className: `app ${app.navigation.sidebarCollapsed ? "sidebar-collapsed" : ""}` })}>
      {!contentOnly && <AppSidebar app={app} />}
      <div className="main">
        <AppStatusBar
          app={app}
          onOpenFile={workbench.openFile}
          onOpenBrowser={() => workbench.select("browser")}
          onToggleWorkbench={() => workbench.active ? workbench.close() : workbench.select("overview")}
          workbenchOpen={!!workbench.active}
          onToggleReview={() => {
            if (workbench.active === "review") workbench.close();
            else workbench.select("review");
          }}
        />
        <AppErrorBanner app={app} />
        {active && <AppOverlays app={app} theme={theme} onThemeChange={onThemeChange} />}
        {active && slash.dialogs}
        {active && <MainPage
          app={app}
          slashCommands={slash.commands}
          onOpenUrl={workbench.openUrl}
          onOpenFile={workbench.openFile}
          draftRequest={fileQuestion?.sessionId === app.catalog.currentSessionId ? fileQuestion : undefined}
          onDraftRequestApplied={() => setFileQuestion(undefined)}
        />}
      </div>
      <AppWorkbench suspended={!active} app={app} workbench={workbench} onDiscuss={(content) => {
        if (app.catalog.currentSessionId) setFileQuestion({ sessionId: app.catalog.currentSessionId, id: Date.now(), content, append: true });
      }} />
    </Container>
  );
}
