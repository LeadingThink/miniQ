import type { MiniqAppController } from "../hooks/useMiniqApp";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { useAppCommands } from "../hooks/useAppCommands";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { buildPaletteCommands } from "./paletteCommands";
import type { CommandId } from "../shortcuts";
import type { ThemeId } from "../theme";
import { type LocalFileTarget } from "../localFiles";
import { Spinner } from "./ui/Spinner";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { TurnChangesContext, type TurnChangesContextValue } from "../turnChanges";
import { ProcessRecordsContext, type ProcessRecordsContextValue } from "../processRecords";
import { Composer } from "./Composer";
import type { ComposerSlashCommand } from "../composerSlash";
import { useAppSlashCommands } from "../hooks/useAppSlashCommands";
import { DistillModal } from "./Distill";
import { ExternalSessionImportDialog } from "./ExternalSessionImport";
import { SchedulePanel } from "./Schedule";
import { SearchOverlay } from "./Search";
import { SettingsPanel } from "./Settings";
import { AppSidebar } from "./AppSidebar";
import { DesktopUpdatePrompt } from "./DesktopUpdatePrompt";
import { HeroPage } from "./HeroPage";
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
import { dispatchCompanionNavigation } from "../companionBridge";
import { localCompanionNotices } from "../companionInboxAdapter";
import { hostKey } from "../hostWorkspace";
import { resolveAttention } from "../companionInbox";
import { SIDE_CHAT_OPEN_EVENT } from "../sessionMenuEvents";

import { useAppWorkbench } from "../hooks/useAppWorkbench";
import { AppWorkbench } from "./AppWorkbench";
import { SideConversationPanel } from "./SideConversationPanel";

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
    !app.feed.loading,
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
  const processRecords = useMemo<ProcessRecordsContextValue>(() => ({
    summaries: app.feed.processSummaries,
    loads: app.feed.processLoads,
    load: app.actions.loadProcess,
  }), [app.feed.processSummaries, app.feed.processLoads, app.actions.loadProcess]);
  const sources = useMemo(() => collectWebSources(app.feed.toolCalls), [app.feed.toolCalls]);
  const pullRequests = useMemo(
    () => detectPullRequests(app.feed.messages, app.feed.toolCalls),
    [app.feed.messages, app.feed.toolCalls],
  );
  return (
    <>
      <div className="session-stage" onScrollCapture={(event) => {
        const root = event.target;
        if (root instanceof HTMLElement && root.classList.contains("timeline")) {
          app.actions.setHistoryPrefetchPinned(root.scrollHeight - root.scrollTop - root.clientHeight < 120);
        }
      }}>
        <Suspense
          fallback={
            <div className="timeline-loading">
              <Spinner size={18} />
              正在加载会话
            </div>
          }
        >
          <TurnChangesContext.Provider value={turnChanges}>
          <ProcessRecordsContext.Provider value={processRecords}>
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
            summary={
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
            }
            latestTurnTiming={app.feed.latestTurnTiming}
            lastTurn={app.feed.lastTurn}
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
          </ProcessRecordsContext.Provider>
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
        onVoiceFocusApplied={app.actions.companionVoiceHandled}
        voiceFocusRequest={app.companionVoiceRequest?.sessionId === app.catalog.currentSessionId ? app.companionVoiceRequest.id : undefined}
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
        <HeroPage app={app} slashCommands={slashCommands} sendBlockedReason={getSendBlockedReason(app)} />
      );
  }
}

export function AppShell({ app, theme, onThemeChange, contentOnly = false, active = true }: AppShellProps) {
  const desktop = useDesktopHost();
  const workbench = useAppWorkbench(app);
  const [fileQuestion, setFileQuestion] = useState<{ sessionId: string; id: number; content: string; append: boolean }>();
  const [sideConversationOpen, setSideConversationOpen] = useState(false);
  const [sideConversationSourceId, setSideConversationSourceId] = useState<string | null>(null);
  const [sideConversationSessionId, setSideConversationSessionId] = useState<string | null>(null);
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

  const viewedSessionId = app.catalog.currentSessionId;
  const viewedHost = app.client.sshHost ?? null;
  useEffect(() => {
    if (!sideConversationOpen || !viewedSessionId) return;
    if (sideConversationSessionId && viewedSessionId === sideConversationSessionId && sideConversationSourceId) {
      void app.actions.openSession(sideConversationSourceId);
      return;
    }
    if (viewedSessionId !== sideConversationSessionId && viewedSessionId !== sideConversationSourceId)
      setSideConversationSourceId(viewedSessionId);
  }, [app.actions.openSession, sideConversationOpen, sideConversationSessionId, sideConversationSourceId, viewedSessionId]);
  useEffect(() => {
    if (!active || !viewedSessionId) return;
    // Opening a finished conversation in the main window settles its reminders everywhere.
    const settle = () => {
      if (document.visibilityState === "visible")
        resolveAttention({ host: viewedHost, sessionId: viewedSessionId, kinds: ["completed", "failed"] });
    };
    settle();
    window.addEventListener("focus", settle);
    document.addEventListener("visibilitychange", settle);
    return () => { window.removeEventListener("focus", settle); document.removeEventListener("visibilitychange", settle); };
  }, [active, viewedSessionId, viewedHost]);

  const commands = useAppCommands(app, active);
  const openSideConversation = () => {
    const source = app.catalog.currentSessionId;
    if (!source) {
      app.setError("先打开一个对话，再开始侧边聊天");
      return;
    }
    setSideConversationSourceId(source);
    workbench.close();
    setSideConversationOpen(true);
  };
  const toggleSideConversation = () => {
    if (sideConversationOpen) setSideConversationOpen(false);
    else openSideConversation();
  };
  const openSideConversationRef = useRef(openSideConversation);
  openSideConversationRef.current = openSideConversation;
  useEffect(() => {
    if (!active) return;
    const open = () => openSideConversationRef.current();
    window.addEventListener(SIDE_CHAT_OPEN_EVENT, open);
    return () => window.removeEventListener(SIDE_CHAT_OPEN_EVENT, open);
  }, [active]);
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
      {!contentOnly && <DesktopUpdatePrompt updater={app.updater} />}
      <div className="main" data-app-active={String(active)}>
        <AppStatusBar
          app={app}
          sideConversationOpen={sideConversationOpen}
          onToggleSideConversation={toggleSideConversation}
          onNewSideChat={openSideConversation}
          showAttentionInbox={active}
          onOpenAttentionLocalItem={(item) => {
            const local = desktop?.catalogs[hostKey(null)] ?? (!app.client.sshHost && app.client.mode === "local" ? app.catalog : null);
            const notice = local && localCompanionNotices([{ ...item, state: "unread" }], local.workspaces, local.sessions)[0];
            if (!notice) { app.setError("提醒对应的本机项目或会话已不可用"); return false; }
            return dispatchCompanionNavigation({ action: "session", workspaceId: notice.workspaceId, sessionId: notice.sessionId });
          }}
          onOpenFile={workbench.openFile}
          onOpenBrowser={() => workbench.select("browser")}
          onOpenGit={() => workbench.select("git")}
          onToggleWorkbench={() => {
            if (workbench.active) workbench.close();
            else {
              setSideConversationOpen(false);
              workbench.select("overview");
            }
          }}
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
      {active && <SideConversationPanel client={app.client} open={sideConversationOpen}
        workspace={app.catalog.currentWorkspace ?? app.catalog.selectedWorkspace}
        sourceSessionId={sideConversationSourceId} onClose={() => setSideConversationOpen(false)}
        onSideSessionChange={async (sessionId) => {
          setSideConversationSessionId(sessionId);
          if (sessionId && app.catalog.currentSessionId === sessionId && sideConversationSourceId)
            await app.actions.openSession(sideConversationSourceId);
        }} />}
      <AppWorkbench suspended={!active} app={app} workbench={workbench} onDiscuss={(content) => {
        if (app.catalog.currentSessionId) setFileQuestion({ sessionId: app.catalog.currentSessionId, id: Date.now(), content, append: true });
      }} />
    </Container>
  );
}
