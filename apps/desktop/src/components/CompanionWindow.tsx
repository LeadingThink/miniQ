import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, AppWindow, ArrowUp, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, EyeOff, Folder, Loader2, MessageSquare, Mic, Minus, Settings, XCircle } from "lucide-react";
import type { RpcClient } from "../rpc";
import { DEFAULT_COMPANION_PREFS, listenCompanionPrefs, readCompanionPrefs, setCompanionMode, type CompanionPrefs } from "../companionPrefs";
import { openCompanionMain, type CompanionDestination } from "../companionBridge";
import { useCompanionInbox } from "../hooks/useCompanionInbox";
import { isTauriRuntime } from "../runtime";
import { errorMessage } from "../errorMessage";
import { subscribeAppearance } from "../theme";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { CompanionAvatar } from "./companion/CompanionAvatar";
import { useCompanionConnection } from "./companion/useCompanionConnection";
import { companionSessionState, COMPANION_STATE_LABELS, mostRelevantSession, sendCompanionTask, type CompanionNotice, type CompanionState, type TaskDraft } from "./companion/companionTask";
import "./CompanionWindow.css";

export interface CompanionWindowProps {
  /** Test/preview injection must be a local client. Production obtains daemon_connection itself. */
  client?: RpcClient;
  initialPrefs?: CompanionPrefs;
  notices?: readonly CompanionNotice[];
  onNoticeOpened?: (id: string) => void;
  /** Optional model snapshot from the shared inbox bridge, keyed by local session ID. */
  modelLabels?: Readonly<Record<string, string>>;
  openMain?: (destination: CompanionDestination) => Promise<void>;
  /** Preview only: start with the panel open (no native resize is requested). */
  initialExpanded?: boolean;
}

/** Tooltip text for the collapsed avatar. */
const SHORT_STATE: Record<CompanionState, string> = { idle: "空闲", running: "运行中", needs_input: "需要处理", failed: "失败", ready: "已完成" };
const DRAG_THRESHOLD = 4;
const LINE = 20;
const MIN_LINES = 2;
const MAX_LINES = 6;
/** Native side reports which edge the expanded panel is anchored to (it grows toward screen centre). */
interface ExpandLayout { alignRight: boolean; alignBottom: boolean }

function NoticeIcon({ state }: { state: CompanionState }) {
  const size = 15;
  if (state === "needs_input") return <AlertCircle size={size} />;
  if (state === "failed") return <XCircle size={size} />;
  if (state === "ready") return <CheckCircle2 size={size} />;
  if (state === "running") return <Loader2 size={size} className="companion-spin" />;
  return <Circle size={size} />;
}

export default function CompanionWindow(props: CompanionWindowProps) {
  const connection = useCompanionConnection(props.client);
  const inbox = useCompanionInbox(connection.workspaces, connection.sessions);
  const notices = props.notices ?? inbox.notices;
  const onNoticeOpened = props.onNoticeOpened ?? (props.notices ? undefined : inbox.onNoticeOpened);
  const [prefs, setPrefs] = useState(props.initialPrefs ?? DEFAULT_COMPANION_PREFS);
  const [expanded, setExpanded] = useState(Boolean(props.initialExpanded));
  const [layout, setLayout] = useState<ExpandLayout>({ alignRight: false, alignBottom: false });
  const [draft, setDraft] = useState<TaskDraft>({ content: "", workspaceId: "", sessionId: null });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [menu, setMenu] = useState<"project" | "session" | "main" | null>(null);
  const sendingRef = useRef(false);
  const lastSubmission = useRef<{ sessionId: string; content: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const projectChip = useRef<HTMLButtonElement>(null);
  const sessionChip = useRef<HTMLButtonElement>(null);
  const mainButton = useRef<HTMLButtonElement>(null);
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);

  // main.tsx already applied the stored theme; follow later changes made in the main window.
  useEffect(() => subscribeAppearance(() => {}), []);
  useEffect(() => {
    if (props.initialPrefs) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void readCompanionPrefs().then((value) => { if (!disposed) setPrefs(value); }).catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    void listenCompanionPrefs((value) => { if (!disposed) { setPrefs(value); setExpanded(false); } })
      .then((dispose) => { if (disposed) dispose(); else off = dispose; })
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; off?.(); };
  }, [props.initialPrefs]);

  const selected = connection.sessions.find((s) => s.id === draft.sessionId);
  const relevant = selected ?? mostRelevantSession(connection.sessions);
  const notice = notices[0];
  const taskFailure = relevant && connection.failures[relevant.id];
  const state = notice?.state ?? (taskFailure ? "failed" : companionSessionState(relevant, relevant ? connection.questions[relevant.id] : false));
  const project = connection.workspaces.find((w) => w.id === draft.workspaceId);
  const projectSessions = connection.sessions.filter((s) => s.workspaceId === draft.workspaceId && !s.archived);
  const model = selected && (props.modelLabels?.[selected.id] ?? connection.models[selected.id]);
  const modelLabel = model ?? (selected ? "会话默认模型" : "项目默认模型");
  useEffect(() => {
    const submitted = lastSubmission.current;
    if (taskFailure && submitted && draft.sessionId === submitted.sessionId) {
      lastSubmission.current = null;
      if (!draft.content) setDraft((current) => ({ ...current, content: submitted.content }));
      setSent(false);
    }
  }, [taskFailure, draft.sessionId, draft.content]);
  // Auto-grow the composer between 2 and 6 lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, LINE * MIN_LINES), LINE * MAX_LINES)}px`;
  }, [draft.content, expanded]);
  const displayedError = error ?? taskFailure ?? connection.error;

  const changeExpanded = async (next: boolean) => {
    try {
      if (isTauriRuntime()) {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<ExpandLayout | null>("companion_expand", { expanded: next });
        if (next && result) setLayout({ alignRight: Boolean(result.alignRight), alignBottom: Boolean(result.alignBottom) });
      }
      setMenu(null);
      setExpanded(next);
      // Only user clicking to expand focuses the input; background status never does.
      if (next) setTimeout(() => input.current?.focus(), 0);
    } catch (cause) { setError(errorMessage(cause)); }
  };
  const openMain = async (destination: CompanionDestination) => {
    try { await (props.openMain ?? openCompanionMain)(destination); return true; }
    catch (cause) { setError(errorMessage(cause)); return false; }
  };
  const openNotice = async (item: CompanionNotice) => {
    if (!await openMain({ action: "session", sessionId: item.sessionId, workspaceId: item.workspaceId })) return;
    try { onNoticeOpened?.(item.id); } catch (cause) { setError(errorMessage(cause)); }
  };
  const send = async () => {
    if (sendingRef.current || !connection.connected) return;
    sendingRef.current = true; setSending(true); setError(null); setSent(false);
    try {
      const result = await sendCompanionTask(connection.client, draft, connection.workspaces, connection.sessions);
      if (result.sent && result.session) lastSubmission.current = { sessionId: result.session.id, content: draft.content };
      setDraft(result.draft); setError(result.error ?? null); setSent(result.sent);
      if (result.session) {
        const task = result.sent ? { ...result.session, status: "running" as const } : result.session;
        connection.setSessions((current) => [...current.filter((s) => s.id !== task.id), task]);
      }
    } finally { sendingRef.current = false; setSending(false); }
  };
  const drag = async () => {
    if (!isTauriRuntime()) return;
    try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().startDragging(); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const hide = async () => {
    try { setPrefs(await setCompanionMode("hidden")); } catch (cause) { setError(errorMessage(cause)); }
  };
  const selectProject = (workspaceId: string) => { setDraft((current) => ({ ...current, workspaceId, sessionId: null })); setSent(false); setError(null); };
  const selectSession = (sessionId: string | null) => { setDraft((current) => ({ ...current, sessionId })); setSent(false); setError(null); };

  // Whole avatar is the drag handle: move past the threshold → native drag; plain click → expand.
  const onAvatarPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    press.current = { x: event.clientX, y: event.clientY, dragging: false };
    suppressClick.current = false;
  };
  const onAvatarPointerMove = (event: ReactPointerEvent) => {
    const start = press.current;
    if (!start || start.dragging || (event.buttons & 1) === 0) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
    start.dragging = true; suppressClick.current = true;
    void drag();
  };
  const endPress = () => { press.current = null; };

  if (prefs.mode === "hidden") return null;
  const stateText = `${COMPANION_STATE_LABELS[state]}${connection.connected ? "" : " · 服务未连接"}`;
  const canSend = connection.connected && !!project && !!draft.content.trim() && !sending;
  return <main className={`companion-window ${expanded ? "expanded" : "collapsed"}`} data-state={state} data-mode={prefs.mode}
    data-align-x={layout.alignRight ? "end" : "start"} data-align-y={layout.alignBottom ? "end" : "start"}>
    {!expanded && <div className="companion-dock">
      <button className="companion-avatar-button" type="button" aria-label={`${COMPANION_STATE_LABELS[state]}，展开任务输入`} aria-expanded={false}
        onPointerDown={onAvatarPointerDown} onPointerMove={onAvatarPointerMove} onPointerUp={endPress} onPointerCancel={endPress}
        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } void changeExpanded(true); }}>
        <CompanionAvatar mode={prefs.mode} state={state} size={64} />
        <span className="companion-badge" data-state={state} aria-hidden="true" />
      </button>
      <span className="companion-tooltip" aria-hidden="true">{SHORT_STATE[state]}</span>
    </div>}
    {expanded && <section className="companion-panel" aria-label="本机任务输入" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); void changeExpanded(false); } }}>
      <header className="companion-header">
        <span className="companion-header-avatar"><CompanionAvatar mode={prefs.mode} state={state} size={prefs.mode === "dots" ? 40 : 24} /></span>
        <strong>miniQ</strong>
        <span className="companion-header-state" title={stateText}>{stateText}</span>
        <span className="companion-header-actions">
          <button ref={mainButton} type="button" className="companion-icon-button" aria-label="打开主窗口" title="打开主窗口" aria-haspopup="menu" aria-expanded={menu === "main"} onClick={() => setMenu(menu === "main" ? null : "main")}><AppWindow size={16} /></button>
          <button type="button" className="companion-icon-button" aria-label="隐藏伙伴" title="隐藏伙伴" onClick={() => void hide()}><EyeOff size={16} /></button>
          <button type="button" className="companion-icon-button" aria-label="缩回伙伴" title="缩回 (Esc)" onClick={() => void changeExpanded(false)}><Minus size={16} /></button>
        </span>
      </header>
      <Menu open={menu === "main"} anchorRef={mainButton} onClose={() => setMenu(null)} label="主窗口">
        {relevant && <MenuItem icon={<MessageSquare size={15} />} onClick={() => void openMain({ action: "session", sessionId: relevant.id, workspaceId: relevant.workspaceId })}>打开当前会话</MenuItem>}
        <MenuItem icon={<Settings size={15} />} onClick={() => void openMain({ action: "settings" })}>主窗口设置 / API Key</MenuItem>
      </Menu>

      {(notices.length > 0 || relevant) && <div className="companion-rows">
        {notices.length > 0 && <div className="companion-inbox" aria-label="伙伴提醒收件箱">
          {notices.slice(0, 3).map((item) => <button key={item.id} className="companion-row" data-state={item.state} type="button" title={`${COMPANION_STATE_LABELS[item.state]} · ${item.text}`} onClick={() => void openNotice(item)}>
            <span className="companion-row-icon" aria-hidden="true"><NoticeIcon state={item.state} /></span>
            <span className="companion-row-text">{item.text}</span>
            <ChevronRight size={14} className="companion-row-chevron" aria-hidden="true" />
          </button>)}
        </div>}
        {relevant && <button className="companion-row companion-row-current" type="button" aria-label={`打开会话：${relevant.title}`} onClick={() => void openMain({ action: "session", sessionId: relevant.id, workspaceId: relevant.workspaceId })}>
          <span className="companion-row-label">当前</span>
          <span className="companion-row-text">{relevant.title}</span>
          <ChevronRight size={14} className="companion-row-chevron" aria-hidden="true" />
        </button>}
      </div>}

      <form className="companion-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea ref={input} aria-label="任务内容" placeholder="让 miniQ 做什么？⌘↵ 发送" rows={MIN_LINES} value={draft.content} disabled={sending}
          onChange={(event) => { setDraft({ ...draft, content: event.target.value }); setSent(false); }}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="companion-composer-bar">
          <button ref={projectChip} type="button" className={`companion-chip ${project ? "" : "placeholder"}`} aria-label="本机项目" title={project ? `${project.name}\n${project.path}` : "请明确选择项目"}
            aria-haspopup="menu" aria-expanded={menu === "project"} disabled={sending} onClick={() => setMenu(menu === "project" ? null : "project")}>
            <Folder size={14} aria-hidden="true" /><span className="companion-chip-text">{project?.name ?? "选择项目"}</span><ChevronDown size={12} aria-hidden="true" />
          </button>
          <button ref={sessionChip} type="button" className="companion-chip" aria-label="目标会话" title={selected?.title ?? "新任务"}
            aria-haspopup="menu" aria-expanded={menu === "session"} disabled={sending || !project} onClick={() => setMenu(menu === "session" ? null : "session")}>
            <span className="companion-chip-text">{selected?.title ?? "新任务"}</span><ChevronDown size={12} aria-hidden="true" />
          </button>
          <span className="companion-model" title={`模型：${modelLabel}（完整配置见主窗口）`}>{project ? modelLabel : ""}</span>
          <button type="button" className="companion-icon-button" aria-label="在主窗口语音输入" title="在主窗口语音输入" disabled={!project || sending}
            onClick={() => void openMain({ action: "voice", workspaceId: draft.workspaceId, sessionId: draft.sessionId })}><Mic size={16} /></button>
          <button type="submit" className="companion-send" aria-label="发送任务" title="发送 (⌘↵)" aria-busy={sending} disabled={!canSend}>
            {sending ? <Loader2 size={16} className="companion-spin" aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
          </button>
        </div>
      </form>
      <Menu open={menu === "project"} anchorRef={projectChip} onClose={() => setMenu(null)} label="选择本机项目" className="companion-menu">
        {connection.workspaces.length === 0 && <MenuItem disabled>{connection.connected ? "暂无项目，请在主窗口创建或授权项目" : "服务未连接"}</MenuItem>}
        {connection.workspaces.map((w) => <MenuItem key={w.id} icon={w.id === draft.workspaceId ? <Check size={14} /> : <Folder size={14} />} title={w.path} onClick={() => selectProject(w.id)}>
          <span className="companion-menu-title">{w.name}</span><span className="companion-menu-sub">{w.path}</span>
        </MenuItem>)}
      </Menu>
      <Menu open={menu === "session"} anchorRef={sessionChip} onClose={() => setMenu(null)} label="选择目标会话" className="companion-menu">
        <MenuItem icon={draft.sessionId === null ? <Check size={14} /> : <span className="companion-menu-spacer" />} onClick={() => selectSession(null)}>新任务</MenuItem>
        {projectSessions.length > 0 && <MenuSeparator />}
        {projectSessions.map((s) => <MenuItem key={s.id} icon={s.id === draft.sessionId ? <Check size={14} /> : <span className="companion-menu-spacer" />} onClick={() => selectSession(s.id)}>
          <span className="companion-menu-title">{s.title}</span><span className="companion-menu-sub">{COMPANION_STATE_LABELS[companionSessionState(s)]}</span>
        </MenuItem>)}
      </Menu>

      {displayedError ? <div className="companion-statusline error" role="alert">
        <span className="companion-statusline-text" title={displayedError}>{displayedError}</span>
        {error && draft.sessionId && <span className="companion-statusline-note">输入已保留</span>}
        {error && draft.sessionId && <button type="button" className="companion-link" title="未确认送达时，请先打开会话检查再重试" onClick={() => void openMain({ action: "session", sessionId: draft.sessionId!, workspaceId: draft.workspaceId })}>打开会话</button>}
        {!connection.connected && <button type="button" className="companion-link" onClick={connection.reconnect}>重新连接</button>}
        <button type="button" className="companion-link" onClick={() => void openMain({ action: "settings" })}>打开设置</button>
      </div> : sent ? <p className="companion-statusline" role="status">已发送到本机项目，输入已清空。</p>
        : connection.connected && connection.workspaces.length === 0 ? <p className="companion-statusline" role="status">暂无项目，请在主窗口创建或授权项目。</p>
        : null}
    </section>}
  </main>;
}
