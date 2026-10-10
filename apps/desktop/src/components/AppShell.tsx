import type { MiniqAppController } from "../hooks/useMiniqApp";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { useAppCommands } from "../hooks/useAppCommands";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { buildPaletteCommands } from "./paletteCommands";
import type { CommandId } from "../shortcuts";
import type { ThemeId } from "../theme";
import { type LocalFileTarget } from "../localFiles";
import { PlugZap, Sparkles } from "lucide-react";
import { Spinner } from "./ui/Spinner";
import { Fragment, lazy, Suspense, useMemo, useState } from "react";
import { TurnChangesContext, type TurnChangesContextValue } from "../turnChanges";
import { Composer, ComposerCard } from "./Composer";
import type { ComposerSlashCommand } from "../composerSlash";
import { useAppSlashCommands } from "../hooks/useAppSlashCommands";
import { DistillModal } from "./Distill";
import { ExternalSessionImportDialog } from "./ExternalSessionImport";
import { ProjectPicker } from "./ProjectPicker";
import { SchedulePanel } from "./Schedule";
import { SearchOverlay } from "./Search";
import { SettingsPanel } from "./Settings";
import { AppSidebar } from "./AppSidebar";
import { StarterPrompts } from "./StarterPrompts";
import { AppErrorBanner, AppStatusBar } from "./AppStatus";
import { SessionModelControls } from "./SessionModelControls";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { RemotePermissionNotice } from "./RemotePermissionNotice";
import { SessionPermissionControls } from "./SessionPermissionControls";
import { SessionGoalBar } from "./SessionGoalBar";
import { AgentPanel, type AgentFocusRequest } from "./AgentPanel";
import { SessionSummaryCard, type SessionSummarySection } from "./SessionSummaryCard";
import { collectWebSources, detectPullRequests } from "../sessionContext";
import { useAgentSummary } from "../hooks/useAgentSummary";
import { ProjectDirectories } from "./ProjectDirectories";
import { hostDraftKey, useDesktopHost } from "../desktopHost";
import { RemotePathDialog } from "./RemotePathDialog";
import { ProviderOnboardingPrompt } from "./ProviderOnboardingPrompt";
import { ExtensionCenter } from "./ExtensionCenter";
import { AttentionInbox } from "./AttentionInbox";

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

function AppOverlays({ app, theme, onThemeChange, runCommand }: AppShellProps & { runCommand: (id: CommandId) => boolean }) {
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
          workspaceId={app.catalog.currentSession?.workspaceId ?? app.catalog.selectedWorkspaceId}
          theme={theme}
          onThemeChange={onThemeChange}
          initialTab={app.navigation.settingsTab}
          onProviderConfigured={() => void app.connection.refreshProviderConfiguration()}
          onClose={() => app.navigation.setShowSettings(false)}
        />
      )}
      {app.navigation.showSearch && (
        <SearchOverlay
          sessions={app.catalog.sessions}
          workspaces={app.catalog.workspaces}
          commands={buildPaletteCommands(app, runCommand)}
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
  onOpenTurnReview: (turnId: string, path?: string) => void;
  onOpenReview: () => void;
  draftRequest?: { id: number; content: string; append?: boolean };
  onDraftRequestApplied?: () => void;
}

export function getSendBlockedReason(app: MiniqAppController): string | undefined {
  if (!app.catalog.currentSessionId && !app.catalog.selectedWorkspace) return "请先选择项目";
  if (app.connection.providerConfigured === false) return "请先在设置的“服务与远程”中配置模型服务";
  if (app.sessionModel.pending) return "正在保存模型配置，请稍候";
  if (!app.sessionModel.ready) return app.sessionModel.error ? "模型配置加载失败，请重试" : "正在加载模型配置，请稍候";
  return undefined;
}

function SessionPage({ app, slashCommands, onOpenFile, onOpenUrl, onOpenReview, onOpenTurnReview, draftRequest, onDraftRequestApplied }: WorkbenchPageProps) {
  const [summarySection, setSummarySection] = useState<SessionSummarySection | null>(null);
  const agentSummary = useAgentSummary(
    app.client,
    app.catalog.currentSessionId!,
    !!app.busy,
  );
  const [agentFocus, setAgentFocus] = useState<AgentFocusRequest | null>(null);
  const openAgentPanel = (agentId?: string) => {
    setSummarySection("agents");
    if (agentId) setAgentFocus((current) => ({ agentId, nonce: (current?.nonce ?? 0) + 1 }));
  };
  const turnChanges = useMemo<TurnChangesContextValue>(() => ({
    client: app.client,
    sessionId: app.catalog.currentSessionId!,
    busy: !!app.busy,
    epoch: app.review.epoch,
    openReview: onOpenTurnReview,
    onReverted: app.review.filesRestored,
  }), [app.client, app.catalog.currentSessionId, app.busy, app.review.epoch, app.review.filesRestored, onOpenTurnReview]);
  const sources = useMemo(() => collectWebSources(app.feed.toolCalls), [app.feed.toolCalls]);
  const pullRequests = useMemo(
    () => detectPullRequests(app.feed.messages, app.feed.toolCalls),
    [app.feed.messages, app.feed.toolCalls],
  );
  return (
    <>
      <div className="session-stage">
        <SessionSummaryCard
          diff={app.review.data}
          agents={agentSummary.agents}
          agentError={agentSummary.error}
          sources={sources}
          pullRequests={pullRequests}
          expanded={summarySection}
          onExpandedChange={setSummarySection}
          onOpenReview={onOpenReview}
          onOpenUrl={onOpenUrl}
          agentPanel={
            <AgentPanel
              client={app.client}
              sessionId={app.catalog.currentSessionId!}
              busy={!!app.busy}
              agents={agentSummary.agents}
              agentError={agentSummary.error}
              onRefreshAgents={agentSummary.refresh}
              focusRequest={agentFocus}
            />
          }
        />
        <Suspense
          fallback={
            <div className="timeline-loading">
              <Spinner size={18} />
              正在加载会话
            </div>
          }
        >
          <TurnChangesContext.Provider value={turnChanges}>
          <Timeline
            client={app.client}
            sessionId={app.catalog.currentSessionId!}
            loading={app.feed.loading}
            historyCursor={app.feed.nextCursor}
            loadingOlder={app.actions.loadingOlder}
            onLoadOlder={app.actions.loadOlder}
            title={app.catalog.currentSession?.title}
            messages={app.feed.messages}
            goal={app.feed.goal}
            toolCalls={app.feed.toolCalls}
            approvals={app.feed.approvals}
            questions={app.feed.questions}
            plan={app.feed.plan}
            turnPlans={app.feed.turnPlans}
            artifacts={app.feed.artifacts}
            queue={app.feed.queue}
            workspacePath={app.catalog.currentSession?.workingDirectory}
            workspacePaths={app.catalog.currentWorkspacePaths}
            streamingText={app.feed.streamingText}
            turnProgress={app.feed.turnProgress}
            agents={agentSummary.agents}
            onOpenAgentPanel={openAgentPanel}
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
            onMoveQueued={app.actions.moveQueued}
            onRewrite={app.actions.rewriteMessage}
            onFork={app.actions.forkSession}
            onStopTurn={app.actions.cancelTurn}
            onError={app.setError}
          />
          </TurnChangesContext.Provider>
        </Suspense>
      </div>
      <SessionGoalBar
        client={app.client}
        sessionId={app.catalog.currentSessionId!}
        goal={app.feed.goal}
        onPauseTurn={app.actions.pauseTurn}
        onResumeTurn={app.actions.resumeTurn}
        onCancelTurn={app.actions.cancelTurn}
        onError={app.setError}
        latestUserMessageAt={[...app.feed.messages].reverse().find((message) => message.role === "user")?.createdAt}
      />
      {app.connection.providerConfigured === false && (
        <ProviderOnboardingPrompt onOpenSettings={() => app.navigation.openSettings("services")} />
      )}
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
        sendBlocked={!!getSendBlockedReason(app)}
        sendBlockedReason={getSendBlockedReason(app)}
        busy={!!app.busy}
        chip={app.catalog.currentWorkspace?.name}
        draftKey={hostDraftKey(app.client.sshHost, app.catalog.currentSessionId!, app.client.storageScope)}
        draftRequest={draftRequest}
        onDraftRequestApplied={onDraftRequestApplied}
        client={app.client}
        sessionId={app.catalog.currentSessionId!}
        messages={app.feed.messages}
        permissionSlot={
          <SessionPermissionControls
            client={app.client}
            sessionId={app.catalog.currentSessionId!}
          />
        }
        allowGoal
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
        {app.connection.providerConfigured === false && (
          <ProviderOnboardingPrompt onOpenSettings={() => app.navigation.openSettings("services")} />
        )}
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
          draftKey={hostDraftKey(app.client.sshHost, "hero", app.client.storageScope)}
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
          allowGoal
          onSend={app.actions.startTask}
          onError={app.setError}
          sendBlocked={!!getSendBlockedReason(app)}
          sendBlockedReason={getSendBlockedReason(app)}
        />
      </div>
      <StarterPrompts
        onSelect={(prompt) =>
          setDraftRequest({ id: Date.now(), content: prompt.prompt })
        }
        shortcuts={[
          {
            id: "skills",
            title: "技能",
            description: "查看可复用的工作流，或从任务中学习新技能",
            icon: Sparkles,
            onSelect: () => app.navigation.setPage("skills"),
          },
          {
            id: "mcp",
            title: "连接器",
            description: "接入办公应用、外部工具与数据服务",
            icon: PlugZap,
            onSelect: () => app.navigation.setPage("mcp"),
          },
        ]}
      />
    </div>
  );
}

function MainPage({ app, slashCommands, onOpenFile, onOpenUrl, onOpenReview, onOpenTurnReview, draftRequest, onDraftRequestApplied }: WorkbenchPageProps) {
  switch (app.navigation.page) {
    case "skills":
    case "mcp":
    case "plugins":
      return <ExtensionCenter client={app.client} workspaceId={app.catalog.currentSession?.workspaceId ?? app.catalog.selectedWorkspaceId}
        selected={app.navigation.page} onSelect={app.navigation.setPage} onClose={() => app.navigation.setPage(null)} />;
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
    default:
      return app.catalog.currentSessionId ? (
        <SessionPage
          key={app.catalog.currentSessionId}
          app={app}
          slashCommands={slashCommands}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
          onOpenTurnReview={onOpenTurnReview}
          onOpenReview={onOpenReview}
          draftRequest={draftRequest}
          onDraftRequestApplied={onDraftRequestApplied}
        />
      ) : (
        <HeroPage app={app} slashCommands={slashCommands} />
      );
  }
}

export function AppShell({ app, theme, onThemeChange, contentOnly = false, active = true }: AppShellProps) {
  const workbench = useAppWorkbench(app);
  const [fileQuestion, setFileQuestion] = useState<{ sessionId: string; id: number; content: string; append: boolean }>();
  const openSessionReview = () => {
    app.review.showSession();
    workbench.select("review");
  };
  const openTurnReview = (turnId: string, path?: string) => {
    app.review.showTurn(turnId, path);
    workbench.select("review");
  };
  const slash = useAppSlashCommands(app, {
    onOpenBrowser: () => workbench.select("browser"),
    onOpenReview: openSessionReview,
  });

  const commands = useAppCommands(app, active);
  useGlobalShortcuts({
    // Keydown and the native-menu `miniq:command` bus share one runner.
    onPalette: () => void commands.runCommand("palette"),
    onNewChat: () => void commands.runCommand("newChat"),
    onSettings: () => void commands.runCommand("settings"),
    onStop: app.busy ? () => void app.actions.cancelTurn() : undefined,
    onToggleSidebar: () => void commands.runCommand("toggleSidebar"),
    onSessionSearch: () => commands.runCommand("find"),
    onShortcut: commands.onShortcut,
  }, active);

  const Container = contentOnly ? Fragment : "div";

  return (
    <Container {...(contentOnly ? {} : { className: `app ${app.navigation.sidebarCollapsed ? "sidebar-collapsed" : ""}` })}>
      {!contentOnly && <AppSidebar app={app} />}
      <div className="main" data-app-active={String(active)}>
        {active && <AttentionInbox app={app} />}
        <AppStatusBar
          app={app}
          onOpenFile={workbench.openFile}
          onOpenBrowser={() => workbench.select("browser")}
          onToggleWorkbench={() => workbench.active ? workbench.close() : workbench.select("overview")}
          workbenchOpen={!!workbench.active}
          onToggleReview={() => {
            if (workbench.active === "review") workbench.close();
            else openSessionReview();
          }}
        />
        <AppErrorBanner app={app} />
        <SettingsLoadErrorBanner client={app.client} />
        <RemotePermissionNotice client={app.client} />
        {active && <AppOverlays app={app} theme={theme} onThemeChange={onThemeChange} runCommand={commands.runCommand} />}
        {active && <KeyboardShortcutsDialog open={commands.showShortcuts} onClose={() => commands.setShowShortcuts(false)} />}
        {active && slash.dialogs}
        {active && <MainPage
          app={app}
          slashCommands={slash.commands}
          onOpenUrl={workbench.openUrl}
          onOpenReview={() => workbench.select("review")}
          onOpenFile={workbench.openFile}
          onOpenTurnReview={openTurnReview}
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
