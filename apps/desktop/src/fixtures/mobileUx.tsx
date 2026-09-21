import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../components/Sidebar";
import { AppStatusBar } from "../components/AppStatus";
import { Timeline } from "../components/Timeline";
import { ComposerCard } from "../components/Composer";
import { SessionModelControls } from "../components/SessionModelControls";
import { WorkbenchPanel } from "../components/WorkbenchPanel";
import { WorkbenchToolbar } from "../components/WorkbenchToolbar";
import { FilePreviewPanel } from "../components/FilePreviewPanel";
import { SessionFileAccess } from "../sessionFileAccess";
import { useSessionModel } from "../hooks/useSessionModel";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { initializeMobileViewport, isMobileLayout } from "../mobileViewport";
import type { WorkbenchView } from "../hooks/useAppWorkbench";
import { fixtureClient, history, report, reportPath, sessions, workspaces } from "./mobileUxData";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/review.css";
import "../styles/pages.css";
import "../styles/remote.css";
import "../styles/experience.css";
import "../styles/mobile-controls.css";

const noop = () => {};
const asyncNoop = async () => {};
function Fixture() {
  const [collapsed, setCollapsed] = useState(isMobileLayout);
  const [sessionId, setSessionId] = useState(sessions[0].id);
  const [workspaceId, setWorkspaceId] = useState(workspaces[0].id);
  const [start, setStart] = useState(16);
  const [pages, setPages] = useState(0);
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(true);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<WorkbenchView>("files");
  const [layout, setLayout] = useState<"mobile" | "split" | "overlay">("split");
  const [expanded, setExpanded] = useState(false);
  const [draftRequest, setDraftRequest] = useState<{ id: number; content: string; append?: boolean }>();
  const model = useSessionModel(fixtureClient, sessionId, workspaceId);
  const session = sessions.find((value) => value.id === sessionId)!;
  const messages = history(sessionId);
  const selectSession = (id: string) => {
    setSessionId(id); setStart(16); setPages(0);
    setWorkspaceId(sessions.find((value) => value.id === id)!.workspaceId);
    if (isMobileLayout()) setCollapsed(true);
  };
  const showFile = () => { setView("files"); setOpen(true); };
  const app = {
    client: fixtureClient,
    connection: { connected, phase: connected ? "connected" : "reconnecting", health: { daemonVersion: "模拟" }, retrying: false, retryConnection: async () => { setConnected(true); setNotice("已同步（仅本地模拟）"); } },
    navigation: { sidebarCollapsed: collapsed, setSidebarCollapsed: setCollapsed, setShowSettings: () => setNotice("模拟界面不读取或保存真实 Key"), setShowDistill: noop },
    catalog: { currentSession: session, currentWorkspace: workspaces.find((value) => value.id === session.workspaceId) },
    busy: false, feed: { messages: [] }, actions: { openSession: selectSession },
    review: { data: { files: [] } }, preview: { viewScope: sessionId }, setError: setNotice,
  } as unknown as MiniqAppController;
  return <SessionFileAccess client={fixtureClient} sessionId={sessionId}>
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      {!collapsed && <button className="mobile-sidebar-scrim" aria-label="关闭侧栏遮罩" onClick={() => setCollapsed(true)} />}
      <Sidebar workspaces={workspaces} sessions={sessions} unreadSessionIds={new Set([sessions[1].id])} currentSessionId={sessionId} selectedWorkspaceId={workspaceId}
        hostGroups={workspaces.map((workspace, index) => ({ key: workspace.id, label: index ? "SSH · 数据分析服务器" : "办公室 Mac", state: "connected", workspaceIds: [workspace.id], selected: workspaceId === workspace.id, onSelect: () => setWorkspaceId(workspace.id) }))}
        onClose={() => setCollapsed(true)} onNewChat={() => setNotice("新对话入口（本地模拟）")} onShowSearch={() => setNotice("请用侧栏的标题搜索或会话内全文搜索验收")} onShowSchedule={noop} onImportSessions={noop}
        onSelectWorkspace={setWorkspaceId} onCreateSession={noop} onDeleteWorkspace={noop} onRenameWorkspace={noop} onEditWorkspace={noop} onSelectSession={selectSession} onSessionSeen={noop} onDeleteSession={noop} onRenameSession={noop} onSetSessionPinned={noop} onSetSessionArchived={noop}
        onShowSkills={noop} onShowMcp={noop} onShowSettings={noop} updateSupported={false} updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null }} onCheckForUpdates={noop} onInstallUpdate={noop} onError={setNotice} />
      <main className="main" data-app-active="true">
        <AppStatusBar app={app} onOpenBrowser={() => { setView("browser"); setOpen(true); }} onToggleReview={noop} onOpenFile={showFile} onToggleWorkbench={() => setOpen(!open)} workbenchOpen={open} />
        <div style={{ fontSize: 11, display: "flex", gap: 8, padding: "2px 12px", alignItems: "center", flexWrap: "wrap", color: "var(--text-dim)" }}>
          <span>模拟验收 · 已请求 {pages} 页</span><button className="ghost" onClick={() => setConnected(!connected)}>模拟断线/恢复</button>
        </div>
        {notice && <div role="status" style={{ padding: 8, overflowWrap: "anywhere" }} onClick={() => setNotice("")}>{notice}</div>}
        <Timeline key={sessionId} client={fixtureClient} sessionId={sessionId} title={session.title} messages={messages.slice(start)} toolCalls={[]} approvals={[]} questions={[]} plan={[]}
          historyCursor={start ? { at: messages[start].createdAt, id: messages[start].id } : null} onLoadOlder={async () => { setStart((value) => Math.max(0, value - 8)); setPages((value) => value + 1); }}
          artifacts={[{ id: "report", sessionId, title: "2026年第三季度用户访谈与产品改进报告完整版.md", path: reportPath, kind: "markdown", createdAt: messages.at(-1)!.createdAt }]} queue={[]} workspacePath={session.workingDirectory}
          streamingText="" turnProgress={null} busy={false} onResolveApproval={noop} onResolveQuestion={noop} onRollback={noop} onOpenFile={showFile} onOpenUrl={noop} onSteerQueued={asyncNoop} onRemoveQueued={asyncNoop} onUpdateQueued={asyncNoop} onRewrite={async () => true} onError={setNotice} />
        <ComposerCard client={fixtureClient} workspaceId={workspaceId} busy={false} placeholder="继续告诉 miniQ 需要做什么…" draftKey={`mobile-ux-fixture-${sessionId}`} draftRequest={draftRequest} onDraftRequestApplied={() => setDraftRequest(undefined)}
          modelSlot={<SessionModelControls client={fixtureClient} model={model} busy={false} />} sendBlocked={!connected} onSend={(content) => { setNotice(`仅模拟发送：${content}`); return true; }} onError={setNotice} />
      </main>
      {open && <WorkbenchPanel expanded={expanded} onRestore={() => setExpanded(false)} onLayoutChange={setLayout}>
        <WorkbenchToolbar active={view} files={1} browsers={0} changes={0} remote hasSession expanded={expanded} mobile={layout === "mobile"} onSelect={setView} onExpand={() => setExpanded(!expanded)} onClose={() => setOpen(false)} />
        <div className="workbench-content" id="miniq-workbench-content">
          {view === "files" ? <FilePreviewPanel withinWorkbench workspacePath={session.workingDirectory} workspacePaths={[session.workingDirectory]} tabs={[{ path: reportPath, line: null, column: null }]} onCloseTab={() => setOpen(false)} preview={{ target: { path: reportPath, line: null, column: null }, resolvedPath: reportPath, open: true, loading: false, error: null, mimeType: "text/markdown", size: 6248, content: report, kind: "markdown", dataBase64: null }}
            onClose={() => setOpen(false)} onOpenFile={noop} onRetry={noop} onDiscuss={(path) => { setOpen(false); setDraftRequest({ id: Date.now(), content: `关于文件「${path}」：\n`, append: true }); }} />
            : <section className="workbench-overview"><h2>{view === "browser" ? "网页记录" : "任务概览"}</h2><p>这是无真实连接的验收页面，不会操作电脑或浏览器。</p><button onClick={() => setView("files")}>查看交付报告</button></section>}
        </div>
      </WorkbenchPanel>}
    </div>
  </SessionFileAccess>;
}
if (import.meta.env.DEV) {
  initializeMobileViewport();
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
