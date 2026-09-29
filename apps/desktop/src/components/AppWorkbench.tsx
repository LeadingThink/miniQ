import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { AppWorkbenchController } from "../hooks/useAppWorkbench";
import { BrowserTabs } from "./BrowserTabs";
import { ReviewPanel } from "./ReviewPanel";
import { WorkbenchPanel } from "./WorkbenchPanel";
import { WorkbenchToolbar } from "./WorkbenchToolbar";
import { WorkbenchOverview } from "./WorkbenchOverview";
import { PreviewViewStore } from "../previewViewState";
import { openTerminalAt } from "../localFiles";
import { isTauriRuntime } from "../runtime";
import type { WorkbenchLauncherActions } from "./WorkbenchLauncher";

const FilePreviewPanel = lazy(() =>
  import("./FilePreviewPanel").then((module) => ({
    default: module.FilePreviewPanel,
  })),
);
const BrowserPanel = lazy(() =>
  import("./BrowserPanel").then((module) => ({ default: module.BrowserPanel })),
);
const RemoteBrowserPanel = lazy(() =>
  import("./RemoteBrowserPanel").then((module) => ({
    default: module.RemoteBrowserPanel,
  })),
);

export function AppWorkbench({
  app,
  workbench,
  onDiscuss,
  suspended = false,
}: {
  app: MiniqAppController;
  workbench: AppWorkbenchController;
  onDiscuss: (content: string) => void;
  suspended?: boolean;
}) {
  const [expandedScope, setExpandedScope] = useState<string | null>(null);
  const [layout, setLayout] = useState<"mobile" | "split" | "overlay">("split");
  const [reviewViews] = useState(() => new PreviewViewStore());
  const [treeOpen, setTreeOpen] = useState(readTreePreference);
  const treeFilter = useRef<HTMLInputElement>(null);
  const focusTree = useRef(false);
  const [treeReveal, setTreeReveal] = useState<{ path: string; nonce: number } | null>(null);
  const expanded = expandedScope === workbench.scope;
  const active = workbench.active;
  const sessionId = app.catalog.currentSessionId;
  const showTree = active === "files" && !!sessionId && layout !== "mobile" && treeOpen;
  const setTree = (open: boolean) => {
    setTreeOpen(open);
    try {
      localStorage.setItem(TREE_KEY, open ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };
  // ⌘P / Ctrl+P: jump to the file tree filter, like a quick-open.
  const quickOpen = useRef<() => void>(() => {});
  quickOpen.current = () => {
    if (!sessionId) return;
    if (layout === "mobile") {
      workbench.select("files");
      return;
    }
    focusTree.current = true;
    setTree(true);
    if (active !== "files") workbench.select("files");
    else treeFilter.current?.focus();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "p" ||
        event.shiftKey ||
        event.altKey ||
        !(MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) ||
        event.defaultPrevented
      )
        return;
      event.preventDefault();
      quickOpen.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (showTree && focusTree.current) {
      focusTree.current = false;
      requestAnimationFrame(() => treeFilter.current?.focus());
    }
  });
  if (!active && !workbench.hasBrowsers) return null;
  const remote = app.client.mode === "remote";
  const workspaceDirectory =
    app.catalog.currentSession?.workingDirectory ?? app.catalog.currentWorkspace?.path;
  const launcher: WorkbenchLauncherActions = {
    onOpenFiles: sessionId ? () => quickOpen.current() : undefined,
    onOpenBrowser: remote
      ? sessionId
        ? () => workbench.select("browser")
        : undefined
      : () =>
          workbench.browserState.tabs.length
            ? workbench.select("browser")
            : workbench.newBrowserTab(),
    browserLabel: remote ? "网页记录" : "浏览器",
    onOpenReview: sessionId ? () => workbench.select("review") : undefined,
    changes: app.review.data.files.length,
    onOpenTerminal:
      !remote && isTauriRuntime() && workspaceDirectory
        ? () =>
            void openTerminalAt(workspaceDirectory).catch((error: unknown) =>
              app.setError(error instanceof Error ? error.message : String(error)),
            )
        : undefined,
  };
  const revealInTree = (path: string) => {
    focusTree.current = false;
    setTree(true);
    setTreeReveal({ path, nonce: Date.now() });
  };
  const overlayOpen =
    app.navigation.showSettings ||
    app.navigation.showSearch ||
    app.navigation.showDistill ||
    app.navigation.showExternalImport ||
    Boolean(app.navigation.editingWorkspaceId);
  const discuss = (content: string) => {
    setExpandedScope(null);
    if (layout !== "split") workbench.close();
    onDiscuss(content);
  };
  return (
    <WorkbenchPanel
      hidden={!active || suspended}
      expanded={expanded}
      onRestore={() => setExpandedScope(null)}
      onLayoutChange={setLayout}
    >
      {active && (
        <WorkbenchToolbar
          active={active}
          files={app.preview.tabs.length}
          browsers={workbench.browserState.tabs.length}
          changes={app.review.data.files.length}
          remote={app.client.mode === "remote"}
          hasSession={!!app.catalog.currentSessionId}
          canPreviewFiles={
            !!app.catalog.currentSessionId ||
            (app.client.mode === "local" && !!app.catalog.currentWorkspace)
          }
          expanded={expanded}
          mobile={layout === "mobile"}
          onExpand={() => setExpandedScope(expanded ? null : workbench.scope)}
          onClose={workbench.close}
          onSelect={workbench.select}
          fileTree={
            active === "files" && sessionId
              ? { open: treeOpen, onToggle: () => setTree(!treeOpen) }
              : undefined
          }
        />
      )}
      <div
        className="workbench-content"
        id="miniq-workbench-content"
        role="tabpanel"
        aria-label={
          active === "browser"
            ? "浏览器工作区"
            : active === "files"
              ? "文件工作区"
              : active === "review"
                ? "审阅工作区"
                : "任务概览工作区"
        }
      >
        {workbench.remoteBrowserOpen && app.catalog.currentSessionId && (
          <Suspense fallback={<div role="status">正在加载网页记录…</div>}>
            <RemoteBrowserPanel
              key={app.catalog.currentSessionId}
              client={app.client}
              sessionId={app.catalog.currentSessionId}
              calls={app.feed.toolCalls}
              hasOlder={Boolean(app.feed.nextCursor)}
              loadingOlder={app.actions.loadingOlder}
              onLoadOlder={() => void app.actions.loadOlder()}
              onClose={workbench.hideBrowser}
              onDiscuss={discuss}
            />
          </Suspense>
        )}
        {workbench.hasBrowsers && (
          <Suspense fallback={<div role="status">正在启动浏览器…</div>}>
            <div
              className="browser-workbench"
              hidden={active !== "browser" || !workbench.browserUrl}
            >
              <BrowserTabs
                tabs={workbench.browserState.tabs}
                activeId={workbench.browserState.activeId}
                onSelect={workbench.selectBrowserTab}
                onClose={workbench.closeBrowserTab}
                onNew={() => workbench.newBrowserTab()}
              />
              {Object.entries(workbench.browserSessions).flatMap(
                ([scope, state]) =>
                  state.tabs.map((tab) => (
                    <BrowserPanel
                      key={tab.id}
                      url={tab.url}
                      viewId={tab.viewId}
                      browserSessionId={tab.browserSessionId}
                      active={
                        scope === workbench.scope &&
                        tab.id === workbench.browserState.activeId &&
                        active === "browser" &&
                        !!workbench.browserUrl
                      }
                      suspended={overlayOpen || suspended}
                      onNavigate={(url) =>
                        workbench.navigateBrowser(scope, tab.id, url)
                      }
                      onClose={workbench.hideBrowser}
                      onDiscuss={
                        app.catalog.currentSessionId
                          ? (url) => discuss(`关于网页 ${url}：\n`)
                          : undefined
                      }
                    />
                  )),
              )}
            </div>
          </Suspense>
        )}
        {active === "review" && (
          <ReviewPanel
            key={app.catalog.currentSessionId}
            diff={app.review.data}
            error={app.review.error}
            viewStore={reviewViews}
            viewScope={workbench.scope}
            onRetry={() => void app.review.refresh()}
            onOpenFile={workbench.openFile}
            onClose={workbench.close}
          />
        )}
        {active === "overview" && (
          <WorkbenchOverview
            key={`${workbench.scope}:${active}`}
            app={app}
            onOpenFile={workbench.openFile}
            launcher={launcher}
          />
        )}
        {active === "files" && (
          <div className={`workbench-files${showTree ? " with-tree" : ""}`}>
            <div className="workbench-files-main">
            {active === "files" &&
              app.preview.state.open &&
              app.catalog.currentWorkspace && (
                <Suspense fallback={<div role="status">正在加载预览…</div>}>
                  <FilePreviewPanel
                    key={app.catalog.currentSessionId}
                    viewStore={app.preview.views}
                    viewScope={app.preview.viewScope}
                    preview={app.preview.state}
                    tabs={app.preview.tabs}
                    onCloseTab={app.preview.closeTab}
                    onCloseOtherTabs={app.preview.closeOtherTabs}
                    onCloseAllTabs={app.preview.closeAllTabs}
                    onReopenClosedTab={app.preview.reopenClosedTab}
                    canReopenClosedTab={app.preview.canReopenClosedTab}
                    workspacePath={
                      app.catalog.currentSession?.workingDirectory ??
                      app.catalog.currentWorkspace.path
                    }
                    workspacePaths={app.catalog.currentWorkspacePaths}
                    authorizedFiles={app.preview.authorizedFiles}
                    onClose={workbench.close}
                    withinWorkbench
                    expanded={expanded}
                    onToggleExpanded={() =>
                      setExpandedScope(expanded ? null : workbench.scope)
                    }
                    onDiscuss={
                      app.catalog.currentSessionId
                        ? (path, selected) =>
                            discuss(
                              `关于文件「${path}」：\n${
                                selected
                                  ? `\n选中内容：\n${selected
                                      .split("\n")
                                      .map((line) => `> ${line}`)
                                      .join("\n")}\n\n修改要求：`
                                  : ""
                              }`,
                            )
                        : undefined
                    }
                    onOpenFile={workbench.openFile}
                    onRevealDirectory={
                      sessionId && layout !== "mobile" ? revealInTree : undefined
                    }
                    onAuthorizeFile={(target, chooseReplacement) =>
                      void app.preview.authorizeFile(target, chooseReplacement)
                    }
                    onRetry={() => {
                      if (app.preview.state.target)
                        workbench.openFile(app.preview.state.target);
                    }}
                  />
                </Suspense>
              )}
              {!app.preview.state.open && (
                <WorkbenchOverview
                  key={`${workbench.scope}:${active}`}
                  app={app}
                  onOpenFile={workbench.openFile}
                  filesOnly
                  fileTreeVisible={showTree}
                  launcher={
                    sessionId && layout !== "mobile"
                      ? { onOpenFiles: launcher.onOpenFiles }
                      : undefined
                  }
                />
              )}
            </div>
            {showTree && sessionId && (
              <aside className="workbench-file-tree-pane" aria-label="项目文件">
                <WorkspaceFileTree
                  key={sessionId}
                  access={{ client: app.client, sessionId }}
                  activePath={
                    app.preview.state.open
                      ? (app.preview.state.resolvedPath ?? app.preview.state.target?.path)
                      : null
                  }
                  filterRef={treeFilter}
                  reveal={treeReveal}
                  onOpen={(path) =>
                    workbench.openFile({ path, line: null, column: null })
                  }
                />
              </aside>
            )}
          </div>
        )}
      </div>
    </WorkbenchPanel>
  );
}

const MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const TREE_KEY = "miniq.workbench.fileTree";
function readTreePreference(): boolean {
  try {
    return localStorage.getItem(TREE_KEY) !== "0";
  } catch {
    return true;
  }
}
