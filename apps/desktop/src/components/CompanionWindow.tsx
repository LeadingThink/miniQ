import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { DEFAULT_COMPANION_PREFS, listenCompanionPrefs, readCompanionPrefs, setCompanionMode, type CompanionPrefs } from "../companionPrefs";
import { openCompanionMain, type CompanionDestination } from "../companionBridge";
import { useCompanionInbox } from "../hooks/useCompanionInbox";
import { isTauriRuntime } from "../runtime";
import { errorMessage } from "../errorMessage";
import { CompanionAvatar } from "./companion/CompanionAvatar";
import { useCompanionConnection } from "./companion/useCompanionConnection";
import { companionSessionState, COMPANION_STATE_LABELS, mostRelevantSession, sendCompanionTask, type CompanionNotice, type TaskDraft } from "./companion/companionTask";
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
}

export default function CompanionWindow(props: CompanionWindowProps) {
  const connection = useCompanionConnection(props.client);
  const inbox = useCompanionInbox(connection.workspaces, connection.sessions);
  const notices = props.notices ?? inbox.notices;
  const onNoticeOpened = props.onNoticeOpened ?? (props.notices ? undefined : inbox.onNoticeOpened);
  const [prefs, setPrefs] = useState(props.initialPrefs ?? DEFAULT_COMPANION_PREFS);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>({ content: "", workspaceId: "", sessionId: null });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const sendingRef = useRef(false);
  const lastSubmission = useRef<{ sessionId: string; content: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
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
  const model = selected && (props.modelLabels?.[selected.id] ?? connection.models[selected.id]);
  useEffect(() => {
    const submitted = lastSubmission.current;
    if (taskFailure && submitted && draft.sessionId === submitted.sessionId) {
      lastSubmission.current = null;
      if (!draft.content) setDraft((current) => ({ ...current, content: submitted.content }));
      setSent(false);
    }
  }, [taskFailure, draft.sessionId, draft.content]);
  const displayedError = error ?? taskFailure ?? connection.error;
  const changeExpanded = async (next: boolean) => {
    try {
      if (isTauriRuntime()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("companion_expand", { expanded: next });
      }
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
  if (prefs.mode === "hidden") return null;
  return <main className={`companion-window ${expanded ? "expanded" : "collapsed"}`} data-state={state}>
    <div className="companion-character-row">
      <button className="companion-character" type="button" aria-label={`${COMPANION_STATE_LABELS[state]}，${expanded ? "缩回" : "展开任务输入"}`} aria-expanded={expanded} onClick={() => void changeExpanded(!expanded)}>
        <CompanionAvatar mode={prefs.mode} state={state} />
        <span className={`companion-status-dot ${state}`} />
      </button>
      <button type="button" className="companion-drag" aria-label="拖动桌面伙伴" title="按住拖动，跨屏移动" onPointerDown={(event) => { if (event.button === 0) void drag(); }}>⠿</button>
    </div>
    {expanded && <section className="companion-pane" aria-label="本机任务输入">
      <header><strong>miniQ · 本机</strong><button type="button" aria-label="缩回伙伴" onClick={() => void changeExpanded(false)}>−</button></header>
      <p className="companion-status" role="status">{COMPANION_STATE_LABELS[state]}{!connection.connected && " · 服务未连接"}</p>
      {!!notices.length && <div className="companion-inbox" aria-label="伙伴提醒收件箱">{notices.map((item) => <button key={item.id} className="companion-session-link" type="button" onClick={() => void openNotice(item)}>{COMPANION_STATE_LABELS[item.state]} · {item.text}</button>)}</div>}
      {relevant && <button className="companion-session-link" type="button" onClick={() => void openMain({ action: "session", sessionId: relevant.id, workspaceId: relevant.workspaceId })}>打开会话：{relevant.title}</button>}
      <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label>项目（本机）<select aria-label="本机项目" value={draft.workspaceId} disabled={sending} onChange={(event) => { setDraft({ ...draft, workspaceId: event.target.value, sessionId: null }); setSent(false); setError(null); }}>
          <option value="">请明确选择项目</option>{connection.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.path}</option>)}
        </select></label>
        {project && <p className="companion-project-path" title={project.path}>{project.path}</p>}
        {connection.connected && connection.workspaces.length === 0 && <p>暂无项目，请在主窗口创建或授权项目。</p>}
        <label>会话<select aria-label="目标会话" value={draft.sessionId ?? ""} disabled={sending || !project} onChange={(event) => { setDraft({ ...draft, sessionId: event.target.value || null }); setSent(false); setError(null); }}>
          <option value="">新建任务</option>{connection.sessions.filter((s) => s.workspaceId === draft.workspaceId && !s.archived).map((s) => <option key={s.id} value={s.id}>{s.title} · {COMPANION_STATE_LABELS[companionSessionState(s)]}</option>)}
        </select></label>
        <p className="companion-model">模型：{model ?? (selected ? "继承此会话默认设置" : "继承所选项目默认设置")}<br /><small>完整模型名称与配置可在主窗口查看。</small></p>
        <textarea ref={input} aria-label="任务内容" placeholder="想让我做什么？" rows={3} value={draft.content} disabled={sending} onChange={(event) => { setDraft({ ...draft, content: event.target.value }); setSent(false); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="companion-actions"><button type="button" disabled={!project || sending} onClick={() => void openMain({ action: "voice", workspaceId: draft.workspaceId, sessionId: draft.sessionId })}>在主窗口语音输入</button>
          <button type="submit" className="companion-send" disabled={!connection.connected || !project || !draft.content.trim() || sending}>{sending ? "发送中…" : "发送任务"}</button></div>
      </form>
      {sent && <p role="status">已发送到本机项目，输入已清空。</p>}
      {displayedError && <div className="companion-error" role="alert"><p>{displayedError}</p>{error && draft.sessionId && <p>未确认送达时，请先打开会话检查再重试；输入已保留。</p>}
        {!connection.connected && <button type="button" onClick={connection.reconnect}>重新连接本机</button>}
        <button type="button" onClick={() => void openMain({ action: "settings" })}>打开主窗口设置 / API Key</button></div>}
      <footer><button type="button" onClick={() => void openMain({ action: "settings" })}>主窗口设置</button><button type="button" onClick={() => void hide()}>隐藏伙伴</button></footer>
    </section>}
  </main>;
}
