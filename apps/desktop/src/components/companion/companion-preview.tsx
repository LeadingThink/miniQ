// Offline visual fixture. No invoke(), WebSocket, daemon, real preferences or microphone.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { RpcClient } from "../../rpc";
import type { CompanionMode } from "../../companionPrefs";
import type { CompanionDestination } from "../../companionBridge";
import type { DaemonEvent, Session, Workspace } from "../../types";
import CompanionWindow from "../CompanionWindow";
import "../../styles/tokens.css";
import "../../styles/base.css";
import "../../styles/themes.css";
import { applyTheme, initializeAppearance, THEMES, type ThemeId } from "../../theme";

initializeAppearance();
document.getElementById("root")!.style.overflow = "auto";
/** Checkerboard reveals any non-transparent square behind the companion. */
const frame = (width: number, height: number) => ({ width, height, flexShrink: 0, backgroundImage: "repeating-conic-gradient(var(--bg-hover) 0 25%, transparent 0 50%)", backgroundSize: "16px 16px", outline: "1px dashed var(--border)" });

const workspace: Workspace = { id: "fixture-project", name: "Companion fixture", path: "/fixture/authorized-project", additionalPaths: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
let tasks: Session[] = [{ id: "fixture-session", workspaceId: workspace.id, workingDirectory: workspace.path, title: "准备桌面伙伴", status: "running", pinned: false, archived: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
const listeners = new Set<(event: DaemonEvent) => void>();
let failSend = false;
let sequence = 0;
const client = {
  mode: "local", connected: true,
  onStatus: () => () => {},
  onEvent: (handler: (event: DaemonEvent) => void) => { listeners.add(handler); return () => listeners.delete(handler); },
  call: async (method: string, raw?: unknown) => {
    if (method === "workspace.list") return { workspaces: [workspace] };
    if (method === "session.list") return { sessions: tasks };
    if (method === "session.create") {
      const task = { ...tasks[0], id: `fixture-created-${++sequence}`, status: "idle" as const, title: "新任务" };
      tasks = [...tasks, task]; return task;
    }
    if (method === "session.sendMessage") {
      if (failSend) throw new Error("Fixture: 缺少 API Key，输入保留");
      const id = (raw as { sessionId: string }).sessionId;
      tasks = tasks.map((task) => task.id === id ? { ...task, status: "running" } : task);
      return {};
    }
    throw new Error(`Fixture blocked unexpected method: ${method}`);
  },
} as unknown as RpcClient;
function Preview() {
  const [mode, setMode] = useState<CompanionMode>("pet");
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "jade");
  const [destination, setDestination] = useState<CompanionDestination | null>(null);
  const open = async (value: CompanionDestination) => { setDestination(value); };
  return <div style={{ display: "flex", gap: 32, padding: 24, minHeight: "100vh", background: "var(--canvas)", color: "var(--text)", alignItems: "flex-start", flexWrap: "wrap" }}>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <small>收起（96×96 窗口）</small>
      <div style={frame(96, 96)}><CompanionWindow key={`c-${mode}`} client={client} initialPrefs={{ mode }} openMain={open} /></div>
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <small>展开（380×520 窗口）</small>
      <div style={frame(380, 520)}><CompanionWindow key={`e-${mode}`} initialExpanded client={client} initialPrefs={{ mode }} modelLabels={{ "fixture-session": "session-default-model" }} openMain={open} /></div>
    </div>
    <aside style={{ fontSize: 14, maxWidth: 420 }}><h2>桌面伙伴 · 离线预览</h2><p>不连接 daemon，不修改设置，不请求麦克风。</p>
      <p><label>主题 <select value={theme} onChange={(event) => { setTheme(event.target.value); applyTheme(event.target.value as ThemeId); }}>{THEMES.map((t) => <option key={t.id} value={t.id}>{t.id} ({t.mode})</option>)}</select></label></p>
      <p><label>外观 <select value={mode} onChange={(event) => setMode(event.target.value as CompanionMode)}><option value="pet">pet</option><option value="dots">dots</option><option value="hidden">hidden</option></select></label></p>
      <p><label><input type="checkbox" onChange={(event) => { failSend = event.target.checked; }} /> 模拟发送失败</label></p>
      <p>状态：{["idle", "running", "waiting_approval", "failed"].map((status) => <button key={status} onClick={() => { tasks = tasks.map((task) => ({ ...task, status: status as Session["status"] })); for (const task of tasks) for (const listener of listeners) listener({ type: "session_status_changed", sessionId: task.id, status: task.status }); }}>{status}</button>)}</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>主窗口事件：{JSON.stringify(destination, null, 2)}</pre>
    </aside>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
