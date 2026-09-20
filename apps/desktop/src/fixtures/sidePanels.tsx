import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../components/Sidebar";
import { WorkbenchToolbar } from "../components/WorkbenchToolbar";
import { WorkbenchPanel } from "../components/WorkbenchPanel";
import { WorkbenchOverview } from "../components/WorkbenchOverview";
import { FilePreviewPanel } from "../components/FilePreviewPanel";
import { ReviewPanel } from "../components/ReviewPanel";
import type { WorkbenchView } from "../hooks/useAppWorkbench";
import type { FilePreviewState } from "../hooks/useFilePreview";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { LocalFileTarget } from "../localFiles";
import type { Artifact, Session, SessionDiff, Workspace } from "../types";
import type { RpcClient } from "../rpc";
import { closePreviewTabs, EMPTY_PREVIEW_TABS, removePreviewTab, reopenPreviewTab, selectPreviewTab, type PreviewTabsState } from "../previewTabs";
import { PreviewViewStore } from "../previewViewState";
import { applyTheme } from "../theme";
import { pdfFixtureBase64 } from "./pdf";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/review.css";
import "../styles/remote.css";
import "../styles/experience.css";
import "../styles/mobile-controls.css";

// Actual production components with synthetic local data. No model, daemon,
// real browser session, credentials or external network requests are involved.
const noop = () => undefined;
const now = new Date().toISOString();
const names = ["交互研究", "市场资料", "产品研发"];
const projects: Workspace[] = names.map((name, index) => ({ id: `workspace-${index}`, name,
  path: `/fixture/${name}`, additionalPaths: [], createdAt: now, updatedAt: now }));
const initialSessions: Session[] = Array.from({ length: 30 }, (_, index) => ({
  id: `session-${index}`, workspaceId: projects[Math.floor(index / 10)].id,
  workingDirectory: "/fixture", title: ["侧边工作面板优化", "资料交叉核对", "生成演示文件", "移动端预览测试", "浏览器任务复盘"][index % 5] + ` · ${index + 1}`,
  status: index % 7 === 1 ? "running" : index % 7 === 2 ? "failed" : index % 7 === 3 ? "waiting_approval" : "idle",
  pinned: index % 10 === 0, archived: index === 29, createdAt: now, updatedAt: now,
}));
const target = (path: string): LocalFileTarget => ({ path, line: null, column: null });
const data: Record<string, Pick<FilePreviewState, "content" | "kind" | "mimeType" | "dataBase64">> = {
  "/fixture/research/report.md": { kind: "markdown", mimeType: "text/markdown", dataBase64: null,
    content: "# 工作面板设计研究\n\n这是可选中、可搜索、可继续提问的真实 Markdown 预览。\n\n## 核心结论\n\n将文件、浏览器与审阅放在同一个工作面板里，让切换保持连续。\n\n| 功能 | 本轮状态 |\n|---|---|\n| 文件标签管理 | 可搜索、关闭与恢复 |\n| 上下文衔接 | 选中文字加入草稿 |\n| 手机适配 | 全屏阅读与可见返回入口 |\n\n" + Array.from({ length: 24 }, (_, index) => `## 观察 ${index + 1}\n\n切换文件时保留当前位置，隐藏面板后仍能找到先前打开的内容。所有操作都归属于当前会话。`).join("\n\n") },
  "/fixture/delivery/report.md": { kind: "markdown", mimeType: "text/markdown", dataBase64: null,
    content: "# 交付摘要\n\n这是不同路径下的同名文件，标签应显示最短可区分目录。\n\n- 检查桌面宽屏布局\n- 检查手机竖屏布局\n- 检查亮色与暗色主题\n\n[查看研究报告](../research/report.md)" },
  "/fixture/results.csv": { kind: "text", mimeType: "text/csv", dataBase64: null,
    content: "序号,场景,通过数,备注\n" + Array.from({ length: 80 }, (_, index) => `${index + 1},${["桌面", "移动端", "多文件"][index % 3]},${10 + index},真实表格预览`).join("\n") },
  "/fixture/preview.html": { kind: "text", mimeType: "text/html", dataBase64: null,
    content: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:system-ui;padding:24px;background:#eef6f1;color:#17352a}button,input{padding:12px;border-radius:8px;border:1px solid #a1b8aa}h1{font-size:28px}</style><h1>本地 HTML 交互预览</h1><p>独立沙箱中的文件预览，不是远端受控浏览器。</p><button onclick="this.textContent=Number(this.textContent)+1">0</button> <input placeholder="输入预览草稿"></html>' },
  "/fixture/diagram.svg": { kind: "text", mimeType: "image/svg+xml", dataBase64: null,
    content: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360"><rect width="720" height="360" rx="24" fill="#e9f2eb"/><g fill="#176344"><rect x="35" y="120" width="170" height="110" rx="18"/><rect x="275" y="120" width="170" height="110" rx="18"/><rect x="515" y="120" width="170" height="110" rx="18"/></g><g fill="white" font-family="system-ui" font-size="24" text-anchor="middle"><text x="120" y="183">对话</text><text x="360" y="183">工作面板</text><text x="600" y="183">交付</text></g><path d="M205 175H275M445 175H515" stroke="#176344" stroke-width="6"/></svg>' },
  "/fixture/document.pdf": { kind: "pdf", mimeType: "application/pdf", content: null, dataBase64: pdfFixtureBase64() },
};
const paths = Object.keys(data);
const initialTabs = paths.reduce((state, path) => selectPreviewTab(state, target(path)), EMPTY_PREVIEW_TABS);
initialTabs.active = paths[0];
const artifacts: Artifact[] = paths.map((path, index) => ({ id: `artifact-${index}`, sessionId: "session-0", path,
  kind: data[path].kind!, title: path.split("/").at(-1)!, createdAt: now }));
const diff: SessionDiff = { additions: 3, deletions: 1, files: paths.slice(0, 2).map((path, index) => ({
  path: path.slice("/fixture/".length), absolutePath: path, oldExists: true, newExists: true, binary: false,
  additions: index ? 1 : 2, deletions: index ? 0 : 1, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
    lines: [ { kind: "context", oldLine: 1, newLine: 1, content: "# 工作面板设计" },
      { kind: "deletion", oldLine: 2, newLine: null, content: "仅展示单个文件" },
      { kind: "addition", oldLine: null, newLine: 2, content: "在同一面板切换文件、浏览器和审阅" },
      { kind: "addition", oldLine: null, newLine: 3, content: "选中内容可以加入会话草稿" } ] }] })), };
const client = { mode: "local", call: async (method: string) => {
  if (method !== "file.list") throw new Error(`此演示没有接入 ${method}`);
  return { roots: ["/fixture"], path: "/fixture", parent: null, nextCursor: null,
    entries: paths.map((path) => ({ path, name: path.slice("/fixture/".length), directory: false, size: 2048, unavailable: false })) };
} } as unknown as RpcClient;

function Fixture() {
  const [sessions, setSessions] = useState(initialSessions);
  const [sessionId, setSessionId] = useState("session-0");
  const [tabsBySession, setTabsBySession] = useState<Record<string, PreviewTabsState>>({ "session-0": initialTabs });
  const [view, setView] = useState<WorkbenchView>("files");
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 720);
  const [dark, setDark] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [views] = useState(() => new PreviewViewStore());
  const tabs = tabsBySession[sessionId] ?? EMPTY_PREVIEW_TABS;
  const session = sessions.find((item) => item.id === sessionId)!;
  const workspace = projects.find((item) => item.id === session.workspaceId)!;
  const updateTabs = (action: (current: PreviewTabsState) => PreviewTabsState) =>
    setTabsBySession((current) => ({ ...current, [sessionId]: action(current[sessionId] ?? EMPTY_PREVIEW_TABS) }));
  const openFile = (file: LocalFileTarget) => { updateTabs((current) => selectPreviewTab(current, file)); setView("files"); setOpen(true); };
  const reopen = () => { updateTabs(reopenPreviewTab); setView("files"); setOpen(true); };
  const updateSession = (id: string, patch: Partial<Session>) => setSessions((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const previewTarget = tabs.targets.find((item) => item.path === tabs.active);
  const file = previewTarget ? data[previewTarget.path] : null;
  const preview: FilePreviewState | null = previewTarget && file ? {
    ...file, target: previewTarget, resolvedPath: previewTarget.path, open: true, loading: false, error: null, size: 2048,
  } : null;
  const app = { catalog: { currentSession: session, currentSessionId: sessionId, currentWorkspace: workspace, currentWorkspacePaths: ["/fixture"] },
    feed: { artifacts, nextCursor: null, plan: [{ content: "对比左右侧边面板", status: "completed" }, { content: "实现预览与审阅衔接", status: "completed" }, { content: "桌面与手机验收", status: "in_progress" }] },
    preview: { canReopenClosedTab: !!tabs.closed.length, reopenClosedTab: reopen }, busy: true, client, setError: setNotice,
  } as unknown as MiniqAppController;
  return <div className={`app ${collapsed ? "sidebar-collapsed" : ""}`} style={{ height: "100dvh" }}>
    <Sidebar workspaces={projects} sessions={sessions} unreadSessionIds={new Set(["session-2", "session-6", "session-12"])}
      currentSessionId={sessionId} selectedWorkspaceId={workspace.id}
      onSelectSession={(id) => { setSessionId(id); setView("overview"); if (window.innerWidth <= 720) setCollapsed(true); }}
      onSelectWorkspace={(id) => { const found = sessions.find((item) => item.workspaceId === id); if (found) { setSessionId(found.id); setView("overview"); } }}
      onSessionSeen={noop} onNewChat={() => setNotice("此页只演示现有会话，不会创建实际任务。")}
      onShowSearch={() => setNotice("使用项目上方的筛选按钮，可以按标题、路径和任务状态查找。")}
      onShowSchedule={noop} onImportSessions={noop} onCreateSession={noop} onDeleteWorkspace={noop}
      onRenameWorkspace={noop} onEditWorkspace={noop} onDeleteSession={noop}
      onRenameSession={(id, title) => updateSession(id, { title })}
      onSetSessionPinned={(id, pinned) => updateSession(id, { pinned })} onSetSessionArchived={(id, archived) => updateSession(id, { archived })}
      onShowSkills={noop} onShowMcp={noop} onShowSettings={noop} updateSupported={false}
      updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null }}
      onCheckForUpdates={noop} onInstallUpdate={noop} onError={setNotice} />
    {!collapsed && <button type="button" className="mobile-sidebar-scrim" aria-label="关闭侧栏" onClick={() => setCollapsed(true)} />}
    <main className="main" style={{ padding: 20, gap: 20, overflow: "auto" }}>
      <nav style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button onClick={() => setCollapsed(!collapsed)}>切换左侧栏</button>
        <button onClick={() => setOpen(true)}>打开工作面板</button>
        <button onClick={() => { setDark(!dark); applyTheme(dark ? "jade" : "night"); }}>切换主题</button>
      </nav>
      <div><h1 style={{ fontSize: 22 }}>侧边工作面板验收</h1><p>{session.title}</p>
        <p>真实生产组件，全部使用合成资料，不会调用模型或连接桌面。</p></div>
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="演示文件">
        {paths.map((path) => <button className="ghost" key={path} onClick={() => openFile(target(path))}>{path.slice("/fixture/".length)}</button>)}
      </section>
      <label>会话草稿<textarea id="panel-fixture-draft" aria-label="会话草稿" value={draft} onChange={(event) => setDraft(event.target.value)}
        placeholder="在文件中选中文字，再点“加入提问”" style={{ display: "block", width: "100%", minHeight: 160, marginTop: 8, fontSize: 16 }} /></label>
      {notice && <p role="status">{notice}</p>}
    </main>
    <WorkbenchPanel hidden={!open} expanded={expanded} onRestore={() => setExpanded(false)}>
      <WorkbenchToolbar active={view} files={tabs.targets.length} browsers={0} changes={diff.files.length} remote={false} hasSession
        expanded={expanded} onExpand={() => setExpanded(!expanded)} onClose={() => setOpen(false)} onSelect={setView} />
      <div className="workbench-content" id="miniq-workbench-content" role="tabpanel" aria-label="工作面板内容">
        {view === "files" && preview && <FilePreviewPanel withinWorkbench expanded={expanded} onToggleExpanded={() => setExpanded(!expanded)}
          viewStore={views} viewScope={sessionId} preview={preview} tabs={tabs.targets} workspacePath="/fixture" workspacePaths={["/fixture"]}
          onOpenFile={openFile} onRetry={noop} onClose={() => setOpen(false)}
          onCloseTab={(path) => updateTabs((current) => removePreviewTab(current, path))}
          onCloseOtherTabs={(path) => updateTabs((current) => closePreviewTabs(current, new Set(current.targets.filter((item) => item.path !== path).map((item) => item.path))))}
          onCloseAllTabs={() => updateTabs((current) => closePreviewTabs(current, new Set(current.targets.map((item) => item.path))))}
          onReopenClosedTab={reopen} canReopenClosedTab={!!tabs.closed.length}
          onDiscuss={(path, selected) => { setDraft(`关于文件「${path}」：\n${selected ? `\n选中内容：\n${selected.split("\n").map((line) => `> ${line}`).join("\n")}\n\n修改要求：` : ""}`);
            setExpanded(false); setOpen(false); requestAnimationFrame(() => document.getElementById("panel-fixture-draft")?.focus()); }} />}
        {(view === "overview" || view === "files" && !preview) && <WorkbenchOverview app={app} onOpenFile={openFile} filesOnly={view === "files"} />}
        {view === "review" && <ReviewPanel viewStore={views} viewScope={sessionId} diff={diff} onOpenFile={openFile} onClose={() => setOpen(false)} />}
        {view === "browser" && <section className="workbench-overview"><h2>浏览器能力需在桌面端验收</h2>
          <p>本页未启动真实浏览器，也不模拟电脑控制。可以打开 HTML 文件，验收隔离的文档预览。</p>
          <button onClick={() => openFile(target("/fixture/preview.html"))}>打开本地 HTML 示例</button></section>}
      </div>
    </WorkbenchPanel>
  </div>;
}

if (import.meta.env.DEV) {
  applyTheme("jade");
  const root = createRoot(document.getElementById("root")!);
  root.render(<Fixture />);
  import.meta.hot?.dispose(() => root.unmount());
}
