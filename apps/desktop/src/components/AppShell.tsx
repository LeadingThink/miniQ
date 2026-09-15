import type { MiniqAppController } from "../hooks/useMiniqApp";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import type { ThemeId } from "../theme";
import { type LocalFileTarget } from "../localFiles";
import { LoaderCircle, PlugZap, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Composer, ComposerCard } from "./Composer";
import { DistillModal } from "./Distill";
import { ExternalSessionImportDialog } from "./ExternalSessionImport";
import { McpPanel } from "./Mcp";
import { PluginsPanel } from "./Plugins";
import { ProjectPicker } from "./ProjectPicker";
import { ReviewPanel } from "./ReviewPanel";
import { SchedulePanel } from "./Schedule";
import { SearchOverlay, type PaletteCommand } from "./Search";
import { SettingsPanel } from "./Settings";
import { Sidebar } from "./Sidebar";
import { SkillsPanel } from "./Skills";
import { StarterPrompts } from "./StarterPrompts";
import { WorkbenchPanel } from "./WorkbenchPanel";
import { AppErrorBanner, AppStatusBar } from "./AppStatus";
import { SessionModelControls } from "./SessionModelControls";
import { SessionPermissionControls } from "./SessionPermissionControls";
import { AgentPanel } from "./AgentPanel";
import { ProjectDirectories } from "./ProjectDirectories";
import { resolveBrowserDriverRequest } from "../embeddedBrowserDriver";
import { BrowserTabs } from "./BrowserTabs";
import { closeBrowserTab, EMPTY_BROWSER_TABS, openBrowserTab, updateBrowserTab, type BrowserTabsState } from "../browserTabs";

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
  const editingWorkspace = app.catalog.workspaces.find(
    (workspace) => workspace.id === app.navigation.editingWorkspaceId,
  );
  return (
    <>
      {editingWorkspace && (
        <ProjectDirectories
          key={editingWorkspace.id}
          workspace={editingWorkspace}
          readOnly={app.client.mode === "remote"}
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
  onOpenFile: (target: LocalFileTarget) => void;
  onOpenUrl: (url: string) => void;
  draftRequest?: { id: number; content: string; append?: boolean };
  onDraftRequestApplied?: () => void;
}

function SessionPage({ app, onOpenFile, onOpenUrl, draftRequest, onDraftRequestApplied }: WorkbenchPageProps) {
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
          hasOlder={Boolean(app.feed.nextCursor)}
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
        draftKey={app.catalog.currentSessionId ?? undefined}
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
          modelSlot={
            <SessionModelControls
              client={app.client}
              model={app.sessionModel}
              busy={false}
            />
          }
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

function MainPage({ app, onOpenFile, onOpenUrl, draftRequest, onDraftRequestApplied }: WorkbenchPageProps) {
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
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
          draftRequest={draftRequest}
          onDraftRequestApplied={onDraftRequestApplied}
        />
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
  const browserScope =
    app.catalog.currentSessionId ??
    `draft:${app.catalog.selectedWorkspaceId ?? ""}`;
  const browserViewIds = useRef(new Map<string, string>());
  const getBrowserViewId = (browserSessionId: string) => {
    const existing = browserViewIds.current.get(browserSessionId);
    if (existing) return existing;
    const viewId = crypto.randomUUID().replaceAll("-", "");
    browserViewIds.current.set(browserSessionId, viewId);
    return viewId;
  };
  const [browserSessions, setBrowserSessions] = useState<Record<string, BrowserTabsState>>({});
  const [fileQuestion, setFileQuestion] = useState<{ sessionId: string; id: number; content: string; append: boolean }>();
  const browserState = browserSessions[browserScope] ?? EMPTY_BROWSER_TABS;
  const activeBrowserTab = browserState.tabs.find((tab) => tab.id === browserState.activeId) ?? null;
  const browserUrl = browserState.open ? activeBrowserTab?.url ?? null : null;
  const setBrowserUrl = (url: string | null) => setBrowserSessions((current) => {
    const state = current[browserScope] ?? EMPTY_BROWSER_TABS;
    if (url === null) return { ...current, [browserScope]: { ...state, open: false } };
    const active = state.activeId ? state.tabs.find((tab) => tab.id === state.activeId) : undefined;
    return { ...current, [browserScope]: active ? updateBrowserTab(state, active.id, url) : openBrowserTab(state, url) };
  });
  const openNewBrowserTab = (url = "https://www.bing.com/") => setBrowserSessions((current) => ({ ...current, [browserScope]: openBrowserTab(current[browserScope] ?? EMPTY_BROWSER_TABS, url) }));
  const openBrowserUrl = (url: string) => {
    app.preview.close();
    app.review.setOpen(false);
    openNewBrowserTab(url);
  };
  useEffect(() => app.client.onEvent((event) => {
    if (event.type !== "browser_driver_requested") return;
    const { request } = event;
    const requestedUrl = request.arguments.url;
    if (request.operation === "open" || request.operation === "navigate") {
      if (typeof requestedUrl !== "string") {
        void app.client.call("browser.resolve", {
          requestId: request.id,
          error: "浏览器导航缺少 URL",
        });
        return;
      }
      const viewId = getBrowserViewId(request.browserSessionId);
      setBrowserSessions((current) => ({
        ...current,
        [request.sessionId]: (() => {
          const state = current[request.sessionId] ?? EMPTY_BROWSER_TABS;
          const existing = state.tabs.find(
            (tab) => tab.browserSessionId === request.browserSessionId,
          );
          const tab = existing ?? {
            id: crypto.randomUUID(),
            url: requestedUrl,
            viewId,
            browserSessionId: request.browserSessionId,
          };
          return {
            tabs: existing
              ? state.tabs.map((candidate) =>
                  candidate.id === existing.id
                    ? { ...candidate, url: requestedUrl }
                    : candidate,
                )
              : [...state.tabs, tab],
            activeId: tab.id,
            open: true,
          };
        })(),
      }));
    }
    void resolveBrowserDriverRequest(app.client, request).finally(() => {
      if (request.operation !== "close") return;
      browserViewIds.current.delete(request.browserSessionId);
      setBrowserSessions((current) => {
        const state = current[request.sessionId];
        const tab = state?.tabs.find(
          (candidate) => candidate.browserSessionId === request.browserSessionId,
        );
        return tab
          ? { ...current, [request.sessionId]: closeBrowserTab(state, tab.id) }
          : current;
      });
    });
  }), [app.client]);
  useEffect(() => {
    const latest = [...app.feed.toolCalls].reverse().find((call) => {
      if (call.toolName !== "browser_automation") return false;
      if (call.status !== "running" && call.status !== "succeeded") return false;
      const input = call.input as Record<string, unknown> | undefined;
      const output = call.output as Record<string, unknown> | undefined;
      return typeof input?.url === "string" || typeof output?.url === "string";
    });
    if (!latest) return;
    const input = latest.input as Record<string, unknown> | undefined;
    const output = latest.output as Record<string, unknown> | undefined;
    const url = typeof input?.url === "string" ? input.url : output?.url;
    if (typeof url === "string" && url.trim()) setBrowserUrl(url);
  }, [app.feed.toolCalls]);
  useEffect(() => {
    const openFromObservation = (event: Event) => {
      const url = (event as CustomEvent<{ url?: unknown }>).detail?.url;
      if (typeof url === "string" && url.trim()) openBrowserUrl(url);
    };
    window.addEventListener("miniq:open-browser", openFromObservation);
    return () => window.removeEventListener("miniq:open-browser", openFromObservation);
  }, [browserScope]);
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
  const closeMobileSidebar = () => {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 720px)").matches
    ) {
      app.navigation.setSidebarCollapsed(true);
    }
  };

  return (
    <div
      className={`app ${app.navigation.sidebarCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <Sidebar
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
        onCreateSession={(workspaceId) =>
          void app.actions.createSession(workspaceId)
        }
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
      <div className="main">
        <AppStatusBar
          app={app}
          onOpenFile={openPreviewFile}
          onOpenBrowser={() => {
            app.preview.close();
            app.review.setOpen(false);
            if (activeBrowserTab) setBrowserSessions((current) => ({ ...current, [browserScope]: { ...browserState, open: true } }));
            else openNewBrowserTab();
          }}
          onToggleReview={() => {
            setBrowserUrl(null);
            app.preview.close();
            app.review.setOpen(!app.review.open);
          }}
        />
        <AppErrorBanner app={app} />
        <AppOverlays app={app} theme={theme} onThemeChange={onThemeChange} />
        <MainPage
          app={app}
          onOpenUrl={openBrowserUrl}
          onOpenFile={openPreviewFile}
          draftRequest={fileQuestion?.sessionId === app.catalog.currentSessionId ? fileQuestion : undefined}
          onDraftRequestApplied={() => setFileQuestion(undefined)}
        />
      </div>
      {(workbenchOpen || Object.values(browserSessions).some((state) => state.tabs.length)) && (
        <WorkbenchPanel hidden={!workbenchOpen}>
          {Object.values(browserSessions).some((state) => state.tabs.length) && (
            <Suspense
              fallback={
                <aside className="browser-panel">
                  <div className="diff-empty">正在启动浏览器...</div>
                </aside>
              }
            >
              <div className="browser-workbench" hidden={!browserUrl}>
              <BrowserTabs
                tabs={browserState.tabs}
                activeId={browserState.activeId}
                onSelect={(id) => setBrowserSessions((current) => ({ ...current, [browserScope]: { ...(current[browserScope] ?? EMPTY_BROWSER_TABS), activeId: id } }))}
                onClose={(id) => setBrowserSessions((current) => ({ ...current, [browserScope]: closeBrowserTab(current[browserScope] ?? EMPTY_BROWSER_TABS, id) }))}
                onNew={() => openNewBrowserTab()}
              />
              {Object.entries(browserSessions).flatMap(([scope, state]) => state.tabs.map((tab) => <BrowserPanel
                key={tab.id}
                url={tab.url}
                viewId={tab.viewId}
                browserSessionId={tab.browserSessionId}
                active={scope === browserScope && tab.id === browserState.activeId && !!browserUrl}
                suspended={
                  app.navigation.showSettings ||
                  app.navigation.showSearch ||
                  app.navigation.showDistill ||
                  app.navigation.showExternalImport ||
                  Boolean(app.navigation.editingWorkspaceId)
                }
                onNavigate={(url) => setBrowserSessions((current) => ({ ...current, [scope]: updateBrowserTab(current[scope] ?? EMPTY_BROWSER_TABS, tab.id, url) }))}
                onClose={() => setBrowserSessions((current) => ({ ...current, [scope]: closeBrowserTab(current[scope] ?? EMPTY_BROWSER_TABS, tab.id) }))}
              />))}
              </div>
            </Suspense>
          )}
          {!browserUrl && app.preview.state.open && app.catalog.currentWorkspace ? (
            <Suspense
              fallback={
                <aside className="file-preview-panel">
                  <div className="diff-empty">正在加载编辑器...</div>
                </aside>
              }
            >
              <FilePreviewPanel
                viewStore={app.preview.views}
                viewScope={app.preview.viewScope}
                key={app.catalog.currentSessionId}
                preview={app.preview.state}
                tabs={app.preview.tabs}
                onCloseTab={app.preview.closeTab}
                workspacePath={
                  app.catalog.currentSession?.workingDirectory ??
                  app.catalog.currentWorkspace.path
                }
                workspacePaths={app.catalog.currentWorkspacePaths}
                onClose={app.preview.close}
                onDiscuss={(path) => {
                  const sessionId = app.catalog.currentSessionId;
                  if (!sessionId) return;
                  setFileQuestion({ sessionId, id: Date.now(), content: `关于文件「${path}」：\n`, append: true });
                  app.preview.close();
                }}
                onOpenFile={(target) => void app.preview.openFile(target)}
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
        </WorkbenchPanel>
      )}
    </div>
  );
}
