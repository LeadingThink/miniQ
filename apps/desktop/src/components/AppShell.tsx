import type { MiniqAppController } from "../hooks/useMiniqApp";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import type { ThemeId } from "../theme";
import { type LocalFileTarget } from "../localFiles";
import {
  clampWorkbenchWidth,
  DEFAULT_WORKBENCH_WIDTH,
  maxWorkbenchWidth,
  MIN_WORKBENCH_WIDTH,
  readWorkbenchWidth,
  WORKBENCH_WIDTH_STORAGE_KEY,
} from "../workbenchWidth";
import { LoaderCircle, PlugZap, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react";
import { Composer, ComposerCard } from "./Composer";
import { DistillModal } from "./Distill";
import { ExternalSessionImportDialog } from "./ExternalSessionImport";
import { McpPanel } from "./Mcp";
import { ProjectPicker } from "./ProjectPicker";
import { ReviewPanel } from "./ReviewPanel";
import { SchedulePanel } from "./Schedule";
import { SearchOverlay, type PaletteCommand } from "./Search";
import { SettingsPanel } from "./Settings";
import { Sidebar } from "./Sidebar";
import { SkillsPanel } from "./Skills";
import { StarterPrompts } from "./StarterPrompts";
import { WorkbenchResizer } from "./WorkbenchResizer";
import { AppErrorBanner, AppStatusBar } from "./AppStatus";

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

const BrowserPanel = lazy(async () => {
  const module = await import("./BrowserPanel");
  return { default: module.BrowserPanel };
});

const Timeline = lazy(async () => {
  const module = await import("./Timeline");
  return { default: module.Timeline };
});

function openFileTarget(app: MiniqAppController, target: LocalFileTarget) {
  app.review.setOpen(false);
  void app.preview.openFile(target);
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
          commands={buildPaletteCommands(app)}
          client={app.client}
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

interface WorkbenchPageProps extends AppOnlyProps {
  onOpenFile: (target: LocalFileTarget) => void;
  onOpenUrl: (url: string) => void;
}

function SessionPage({ app, onOpenFile, onOpenUrl }: WorkbenchPageProps) {
  return (
    <>
      <Suspense
        fallback={
          <div className="timeline-loading">
            <LoaderCircle className="connection-spinner" size={18} />
            正在加载会话
          </div>
        }
      >
        <Timeline
          messages={app.feed.messages}
          toolCalls={app.feed.toolCalls}
          approvals={app.feed.approvals}
          questions={app.feed.questions}
          plan={app.feed.plan}
          artifacts={app.feed.artifacts}
          queue={app.feed.queue}
          workspacePath={app.catalog.currentWorkspace?.path}
          streamingText={app.feed.streamingText}
          turnProgress={app.feed.turnProgress}
          busy={!!app.busy}
          onResolveApproval={app.actions.resolveApproval}
          onResolveQuestion={app.actions.resolveQuestion}
          onRollback={app.actions.rollbackCheckpoint}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
          onSteerQueued={(id) => void app.actions.steerQueued(id)}
          onRemoveQueued={(id) => void app.actions.removeQueued(id)}
          onError={app.setError}
        />
      </Suspense>
      <Composer
        busy={!!app.busy}
        chip={app.catalog.currentWorkspace?.name}
        draftKey={app.catalog.currentSessionId ?? undefined}
        client={app.client}
        approvalMode={app.connection.approvalMode}
        onApprovalModeChange={app.connection.changeApprovalMode}
        onSend={app.actions.sendMessage}
        onCancel={app.actions.cancelTurn}
        onError={app.setError}
      />
    </>
  );
}

function HeroPage({ app }: AppOnlyProps) {
  const selectedWorkspace = app.catalog.selectedWorkspace;
  const [draftRequest, setDraftRequest] = useState<
    { id: number; content: string } | undefined
  >();
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
          draftKey="hero"
          draftRequest={draftRequest}
          client={app.client}
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
          onError={app.setError}
          sendBlocked={!selectedWorkspace}
          sendBlockedReason="请先选择项目"
        />
      </div>
      <StarterPrompts
        onSelect={(prompt) =>
          setDraftRequest({ id: Date.now(), content: prompt.prompt })
        }
      />
      <div className="hero-cards">
        <button type="button" className="hero-card" onClick={() => app.navigation.setPage("skills")}>
          <div className="hero-card-title"><Sparkles size={14} />技能</div>
          <div className="hero-card-sub">查看可复用的工作流,或从任务中学习新技能</div>
        </button>
        <button type="button" className="hero-card" onClick={() => app.navigation.setPage("mcp")}>
          <div className="hero-card-title"><PlugZap size={14} />连接 MCP</div>
          <div className="hero-card-sub">接入外部工具与服务,扩展 agent 能力</div>
        </button>
      </div>
    </div>
  );
}

function MainPage({ app, onOpenFile, onOpenUrl }: WorkbenchPageProps) {
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
        <SessionPage app={app} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
      ) : (
        <HeroPage app={app} />
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

export function AppShell({ app, theme, onThemeChange }: AppShellProps) {
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [workbenchWidth, setWorkbenchWidth] = useState(() =>
    readWorkbenchWidth(
      window.localStorage,
      window.innerWidth,
      app.navigation.sidebarCollapsed,
    ),
  );
  const workbenchMax = maxWorkbenchWidth(
    window.innerWidth,
    app.navigation.sidebarCollapsed,
  );
  const resizeWorkbench = (width: number) => {
    const next = clampWorkbenchWidth(
      width,
      window.innerWidth,
      app.navigation.sidebarCollapsed,
    );
    setWorkbenchWidth(next);
    window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(next));
  };

  useEffect(() => {
    const handleResize = () => {
      setWorkbenchWidth((current) => {
        const next = clampWorkbenchWidth(
          current,
          window.innerWidth,
          app.navigation.sidebarCollapsed,
        );
        window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(next));
        return next;
      });
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [app.navigation.sidebarCollapsed]);

  const openBrowserUrl = (url: string) => {
    app.preview.close();
    app.review.setOpen(false);
    setBrowserUrl(url);
  };
  const openPreviewFile = (target: LocalFileTarget) => {
    setBrowserUrl(null);
    openFileTarget(app, target);
  };

  useGlobalShortcuts({
    onPalette: () => app.navigation.setShowSearch(!app.navigation.showSearch),
    onNewChat: app.actions.newChat,
    onSettings: () => app.navigation.setShowSettings(true),
    onStop: app.busy ? () => void app.actions.cancelTurn() : undefined,
    onToggleSidebar: () =>
      app.navigation.setSidebarCollapsed(!app.navigation.sidebarCollapsed),
  });

  const workbenchOpen = Boolean(
    browserUrl ||
    (app.preview.state.open && app.catalog.currentWorkspace) ||
    (app.review.open && app.catalog.currentWorkspace),
  );
  const appStyle = {
    "--workbench-width": `${workbenchWidth}px`,
  } as CSSProperties;
  const closeMobileSidebar = () => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches) {
      app.navigation.setSidebarCollapsed(true);
    }
  };

  return (
    <div
      className={`app ${app.navigation.sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      style={appStyle}
    >
      <Sidebar
        workspaces={app.catalog.workspaces}
        sessions={app.catalog.sessions}
        unreadSessionIds={app.unreadSessionIds}
        currentSessionId={app.catalog.currentSessionId}
        selectedWorkspaceId={app.catalog.selectedWorkspace?.id ?? null}
        onNewChat={() => { app.actions.newChat(); closeMobileSidebar(); }}
        onShowSearch={() => { app.navigation.setShowSearch(true); closeMobileSidebar(); }}
        onShowSchedule={() => { app.navigation.setPage("schedule"); closeMobileSidebar(); }}
        onImportSessions={() => { app.navigation.setShowExternalImport(true); closeMobileSidebar(); }}
        onSelectWorkspace={(workspaceId) => { app.actions.selectWorkspace(workspaceId); closeMobileSidebar(); }}
        onCreateSession={(workspaceId) => void app.actions.createSession(workspaceId)}
        onDeleteWorkspace={(workspaceId) => void app.actions.deleteWorkspace(workspaceId)}
        onRenameWorkspace={(workspaceId, name) => void app.actions.renameWorkspace(workspaceId, name)}
        onSelectSession={(sessionId) => { closeMobileSidebar(); void app.actions.openSession(sessionId); }}
        onSessionSeen={app.markSessionSeen}
        onDeleteSession={(sessionId) => void app.actions.deleteSession(sessionId)}
        onRenameSession={(sessionId, title) => void app.actions.renameSession(sessionId, title)}
        onSetSessionPinned={(sessionId, pinned) => void app.actions.setSessionPinned(sessionId, pinned)}
        onSetSessionArchived={(sessionId, archived) => void app.actions.setSessionArchived(sessionId, archived)}
        onShowSkills={() => { app.navigation.setPage("skills"); closeMobileSidebar(); }}
        onShowMcp={() => { app.navigation.setPage("mcp"); closeMobileSidebar(); }}
        onShowSettings={() => { app.navigation.setShowSettings(true); closeMobileSidebar(); }}
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
      <div className="main">
        <AppStatusBar
          app={app}
          onOpenBrowser={() => openBrowserUrl("https://www.bing.com/")}
          onToggleReview={() => {
            setBrowserUrl(null);
            app.preview.close();
            app.review.setOpen(!app.review.open);
          }}
        />
        <AppErrorBanner app={app} />
        <AppOverlays app={app} theme={theme} onThemeChange={onThemeChange} />
        <MainPage app={app} onOpenUrl={openBrowserUrl} onOpenFile={openPreviewFile} />
      </div>
      {workbenchOpen && (
        <WorkbenchResizer
          width={workbenchWidth}
          min={MIN_WORKBENCH_WIDTH}
          max={workbenchMax}
          onResize={resizeWorkbench}
          onReset={() => resizeWorkbench(DEFAULT_WORKBENCH_WIDTH)}
        />
      )}
      {browserUrl ? (
        <Suspense
          fallback={<aside className="browser-panel"><div className="diff-empty">正在启动浏览器...</div></aside>}
        >
          <BrowserPanel
            url={browserUrl}
            onNavigate={setBrowserUrl}
            onClose={() => setBrowserUrl(null)}
          />
        </Suspense>
      ) : app.preview.state.open && app.catalog.currentWorkspace ? (
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
            onRetry={() => {
              const target = app.preview.state.target;
              if (target) void app.preview.openFile(target);
            }}
          />
        </Suspense>
      ) : app.review.open && app.catalog.currentWorkspace ? (
        <ReviewPanel
          diff={app.review.data}
          onOpenFile={openPreviewFile}
          onClose={() => app.review.setOpen(false)}
        />
      ) : null}
    </div>
  );
}
