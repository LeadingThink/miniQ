import { ArrowUp, Loader2, MessageSquareText, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { createSideConversationState, EMPTY_SIDE_CONVERSATION, isSideConversationExpired, releaseSideConversation, SIDE_CONVERSATION_IDLE_MS, type SideConversationState } from "../sideConversation";
import type { Message, Session, SessionForkInfo, Workspace } from "../types";
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

export function SideConversationPanel({ client, open, workspace, sourceSessionId, onClose, onSideSessionChange, idleMs = SIDE_CONVERSATION_IDLE_MS }: Props) {
  const [conversation, setConversation] = useState<SideConversationState>(EMPTY_SIDE_CONVERSATION);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkInfo, setForkInfo] = useState<SessionForkInfo | null>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

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
      const released = await releaseSideConversation(client, current, { cancel: busy });
      conversationRef.current = released;
      setConversation(released);
      setMessages([]); setStreamingText(""); setBusy(false); setError(null); setForkInfo(null);
      await onSideSessionChange?.(null);
    } catch (cause) { setError(errorMessage(cause)); }
  };

  useEffect(() => () => {
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

  const send = async () => {
    const content = draft.trim();
    if (!content || busy || !workspace) return;
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
      setMessages((items) => [...items, optimistic]); setDraft("");
      await client.call("session.sendMessage", { sessionId: current.sessionId, message: { role: "user", content, attachments: [] }, rejectIfBusy: true });
      const activeConversation = { ...current, lastActivityAt: Date.now() };
      conversationRef.current = activeConversation;
      setConversation(activeConversation);
      await refresh(current.sessionId!);
    } catch (cause) { setBusy(false); setError(errorMessage(cause)); setDraft(content); }
  };

  if (!open) return null;
  return <aside className="side-conversation" aria-label="侧边聊天">
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
      <textarea aria-label="侧边聊天内容" placeholder={!sourceSessionId ? "先打开一个对话" : workspace ? "快速追问…" : "请先选择项目"} rows={3} value={draft} disabled={!workspace || !sourceSessionId || busy} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <button type="submit" aria-label="发送侧边聊天" title="发送 (⌘/Ctrl+Enter)" disabled={!workspace || !sourceSessionId || busy || !draft.trim()}>{busy ? <Loader2 size={16} /> : <ArrowUp size={16} />}</button>
    </form>
  </aside>;
}
