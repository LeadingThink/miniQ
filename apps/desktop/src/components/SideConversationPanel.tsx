import { ArrowUp, Loader2, MessageSquareText, Paperclip, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MAX_COMPOSER_ATTACHMENTS, canSendComposer } from "../composerInput";
import { errorMessage } from "../errorMessage";
import { useDroppedFiles } from "../hooks/useDroppedFiles";
import { savePastedFile } from "../localFiles";
import { isTauriRuntime } from "../runtime";
import type { RpcClient } from "../rpc";
import { createSideConversationState, EMPTY_SIDE_CONVERSATION, isSideConversationExpired, releaseSideConversation, SIDE_CONVERSATION_IDLE_MS, type SideConversationState } from "../sideConversation";
import type { Message, Session, SessionForkInfo, Workspace } from "../types";
import { AttachmentPreview } from "./AttachmentPreview";
import { Md } from "./Md";
import "./SideConversationPanel.css";

interface Props {
  client: RpcClient;
  open: boolean;
  workspace: Workspace | null;
  sourceSessionId: string | null;
  onClose: () => void;
  onSideSessionChange?: (sessionId: string | null) => void | Promise<void>;
  idleMs?: number;
}

interface SessionSnapshot { messages: Message[]; streamingText?: string; fork?: SessionForkInfo }

const SIDE_WIDTH_KEY = "miniq.sideConversationWidth";
const SIDE_WIDTH_DEFAULT = 380;
const SIDE_WIDTH_MIN = 300;
const SIDE_WIDTH_MAX = 760;

function storedWidth(): number {
  const value = Number(localStorage.getItem(SIDE_WIDTH_KEY));
  if (!Number.isFinite(value)) return SIDE_WIDTH_DEFAULT;
  return Math.min(SIDE_WIDTH_MAX, Math.max(SIDE_WIDTH_MIN, Math.round(value)));
}

function uniquePaths(current: string[], incoming: string[]): { paths: string[]; dropped: number } {
  const paths = [...new Set([...current, ...incoming])].slice(0, MAX_COMPOSER_ATTACHMENTS);
  return { paths, dropped: Math.max(0, current.length + incoming.filter((path) => !current.includes(path)).length - MAX_COMPOSER_ATTACHMENTS) };
}

export function SideConversationPanel({ client, open, workspace, sourceSessionId, onClose, onSideSessionChange, idleMs = SIDE_CONVERSATION_IDLE_MS }: Props) {
  const [conversation, setConversation] = useState<SideConversationState>(EMPTY_SIDE_CONVERSATION);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkInfo, setForkInfo] = useState<SessionForkInfo | null>(null);
  const [width, setWidth] = useState(storedWidth);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const drag = useRef<(() => void) | null>(null);

  const refresh = async (sessionId: string) => {
    const snapshot = await client.call<SessionSnapshot>("session.open", { sessionId, limit: 50, view: "visible" });
    if (conversationRef.current.sessionId !== sessionId) return;
    setMessages(snapshot.messages ?? []);
    setStreamingText(snapshot.streamingText ?? "");
    if (snapshot.fork) setForkInfo(snapshot.fork);
  };
  const release = async () => {
    const current = conversationRef.current;
    if (!current.sessionId) return;
    try {
      const released = await releaseSideConversation(client, current, { cancel: busyRef.current });
      conversationRef.current = released;
      setConversation(released);
      setMessages([]); setStreamingText(""); setBusy(false); setError(null); setForkInfo(null); setAttachments([]);
      await onSideSessionChange?.(null);
    } catch (cause) { setError(errorMessage(cause)); }
  };

  useEffect(() => () => {
    drag.current?.();
    const current = conversationRef.current;
    if (current.sessionId) void releaseSideConversation(client, current, { cancel: true }).catch(() => undefined);
  }, [client]);

  useEffect(() => client.onEvent((event) => {
    const sessionId = conversationRef.current.sessionId;
    if (!sessionId) return;
    if (event.type === "session_status_changed") {
      if (event.sessionId !== sessionId) return;
      setBusy(event.status === "running" || event.status === "cancelling");
    }
    if (event.type === "turn_completed" || event.type === "turn_failed") {
      if (event.sessionId !== sessionId) return;
      setBusy(false);
      void refresh(sessionId).catch((cause) => setError(errorMessage(cause)));
    }
  }), [client]);

  useEffect(() => {
    const current = conversationRef.current;
    if (!current.sessionId) return;
    if (current.workspaceId === workspace?.id && current.sourceSessionId === sourceSessionId) return;
    void release();
  }, [workspace?.id, sourceSessionId]);

  useEffect(() => {
    if (open) return;
    void release();
  }, [open]);

  useEffect(() => {
    if (!conversation.sessionId || busy) return;
    const remaining = Math.max(0, idleMs - (Date.now() - conversation.lastActivityAt));
    const timer = window.setTimeout(() => {
      if (isSideConversationExpired(conversationRef.current, Date.now(), idleMs)) void release();
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [conversation, busy, idleMs]);

  const addAttachments = (paths: string[]) => {
    if (busyRef.current) return;
    const merged = uniquePaths(attachmentsRef.current, paths);
    setAttachments(merged.paths);
    if (merged.dropped > 0) setError(`每条消息最多附加 ${MAX_COMPOSER_ATTACHMENTS} 个文件，${merged.dropped} 个未添加`);
  };
  useDroppedFiles(textareaRef, addAttachments, setError);

  const pickFiles = async () => {
    if (busy || !isTauriRuntime()) {
      if (!isTauriRuntime()) setError("附加文件仅在 miniQ 桌面应用中可用");
      return;
    }
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({ multiple: true, title: "附加文件" });
      if (Array.isArray(selected)) addAttachments(selected);
      else if (typeof selected === "string") addAttachments([selected]);
    } catch (cause) { setError(`无法选择附件: ${errorMessage(cause)}`); }
  };

  const pasteFiles = async (files: File[]) => {
    if (busy || files.length === 0) return;
    if (!isTauriRuntime()) { setError("粘贴文件仅在 miniQ 桌面应用中可用"); return; }
    try {
      addAttachments(await Promise.all(files.map((file) => savePastedFile(file))));
    } catch (cause) { setError(`无法粘贴文件: ${errorMessage(cause)}`); }
  };

  const send = async () => {
    const content = draft.trim();
    const files = attachmentsRef.current;
    if (!canSendComposer(content, files) || busy || !workspace) return;
    if (!sourceSessionId) { setError("先打开一个对话，再开始侧边聊天"); return; }
    setBusy(true); setError(null);
    try {
      let current = conversationRef.current;
      if (!current.sessionId) {
        const session = await client.call<Session>("session.fork", { sessionId: sourceSessionId, mode: "side" });
        current = createSideConversationState(session, sourceSessionId);
        conversationRef.current = current;
        setConversation(current);
        onSideSessionChange?.(session.id);
        const snapshot = await client.call<SessionSnapshot>("session.open", { sessionId: session.id, limit: 50, view: "visible" });
        if (snapshot.fork) setForkInfo(snapshot.fork);
      }
      const optimistic: Message = { id: `side-user-${Date.now()}`, sessionId: current.sessionId!, role: "user", content, createdAt: new Date().toISOString() };
      setMessages((items) => [...items, optimistic]); setDraft(""); setAttachments([]);
      await client.call("session.sendMessage", { sessionId: current.sessionId, message: { role: "user", content, attachments: files }, rejectIfBusy: true });
      const activeConversation = { ...current, lastActivityAt: Date.now() };
      conversationRef.current = activeConversation;
      setConversation(activeConversation);
      await refresh(current.sessionId!);
    } catch (cause) { setBusy(false); setError(errorMessage(cause)); setDraft(content); setAttachments(files); }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    let x = event.clientX;
    let next = width;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      next = Math.min(SIDE_WIDTH_MAX, Math.max(SIDE_WIDTH_MIN, next + x - pointer.clientX));
      x = pointer.clientX;
      setWidth(Math.round(next));
    };
    const stop = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      const committed = Math.round(next);
      setWidth(committed);
      localStorage.setItem(SIDE_WIDTH_KEY, String(committed));
    };
    const cleanup = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("workbench-resizing");
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    handle.setPointerCapture(pointerId);
    document.body.classList.add("workbench-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    drag.current = cleanup;
  };

  if (!open) return null;
  const canCompose = !!workspace && !!sourceSessionId && !busy;
  return <aside className="side-conversation" style={{ width, flexBasis: width }} aria-label="侧边聊天">
    <div
      className="workbench-resizer side-conversation-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边聊天宽度"
      aria-valuemin={SIDE_WIDTH_MIN}
      aria-valuemax={SIDE_WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整侧边聊天宽度"
      onPointerDown={startResize}
      onDoubleClick={() => { setWidth(SIDE_WIDTH_DEFAULT); localStorage.setItem(SIDE_WIDTH_KEY, String(SIDE_WIDTH_DEFAULT)); }}
    />
    <header>
      <span className="side-conversation-title"><MessageSquareText size={16} /><strong>侧边聊天</strong></span>
      <span className="side-conversation-actions">
        <button type="button" aria-label="删除侧边聊天" title="删除侧边聊天" disabled={!conversation.sessionId} onClick={() => void release()}><Trash2 size={16} /></button>
        <button type="button" aria-label="关闭侧边聊天" title="关闭" onClick={onClose}><X size={17} /></button>
      </span>
    </header>
    <p className="side-conversation-context" title={workspace?.path}>
      {workspace
        ? `${workspace.name} · ${forkInfo?.parentTitle ? `继承「${forkInfo.parentTitle}」` : "继承主对话上下文"}`
        : "请先选择项目"}
    </p>
    <div className="side-conversation-messages" aria-live="polite">
      {messages.length === 0 && !streamingText && <p className="side-conversation-empty">
        {forkInfo
          ? `已继承 ${forkInfo.inheritedMessageCount} 条上下文，可以开始追问。`
          : sourceSessionId ? "可在这里快速追问，不打断主会话。" : "先在主对话里打开一个会话。"}
      </p>}
      {messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => <article key={message.id} data-role={message.role}>
        <span>{message.role === "user" ? "你" : "miniQ"}</span><Md workspacePath={workspace?.path}>{message.content}</Md>
      </article>)}
      {streamingText && <article data-role="assistant"><span>miniQ</span><Md workspacePath={workspace?.path} streaming>{streamingText}</Md></article>}
      {busy && <p className="side-conversation-running" role="status"><Loader2 size={14} /> 正在处理</p>}
    </div>
    {error && <p className="side-conversation-error" role="alert">{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {attachments.length > 0 && <div className="attach-row">
        {attachments.map((path) => <AttachmentPreview key={path} path={path} sending={busy} onRemove={() => setAttachments((items) => items.filter((item) => item !== path))} />)}
      </div>}
      <textarea ref={textareaRef} aria-label="侧边聊天内容" placeholder={!sourceSessionId ? "先打开一个对话" : workspace ? "快速追问，可附加文件…" : "请先选择项目"} rows={3} value={draft} disabled={!workspace || !sourceSessionId || busy} onChange={(event) => setDraft(event.target.value)}
        onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length > 0) { event.preventDefault(); void pasteFiles(files); } }}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <button type="button" className="side-conversation-attach" aria-label="附加文件" title="附加文件" disabled={!canCompose} onClick={() => void pickFiles()}><Paperclip size={15} /></button>
      <button type="submit" aria-label="发送侧边聊天" title="发送 (⌘/Ctrl+Enter)" disabled={!canCompose || !canSendComposer(draft, attachments)}>{busy ? <Loader2 size={16} /> : <ArrowUp size={16} />}</button>
    </form>
  </aside>;
}
