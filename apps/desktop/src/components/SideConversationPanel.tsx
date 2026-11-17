import { ArrowUp, Loader2, MessageSquareText, Paperclip, Trash2, X } from "lucide-react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { canSendComposer } from "../composerInput";
import { errorMessage } from "../errorMessage";
import { useDroppedFiles } from "../hooks/useDroppedFiles";
import { savePastedFile } from "../localFiles";
import { isTauriRuntime } from "../runtime";
import { SessionFileAccess } from "../sessionFileAccess";
import type { RpcClient } from "../rpc";
import { createSideConversationState, clearStoredSideConversation, EMPTY_SIDE_CONVERSATION, isSideConversationExpired, readStoredSideConversation, releaseSideConversation, sideConversationStorageKey, SIDE_CONVERSATION_IDLE_MS, storeSideConversation, type SideConversationState } from "../sideConversation";
import type { Message, Session, SessionForkInfo, Workspace } from "../types";
import { uploadRemoteFile } from "../remoteTransfer";
import { AttachmentPreview } from "./AttachmentPreview";
import { MessageAttachmentPreview } from "./MessageAttachmentPreview";
import { Md } from "./Md";
import { DeepThinking } from "./DeepThinking";
import { WorkbenchResizer } from "./WorkbenchResizer";
import "./SideConversationPanel.css";

interface Props {
  ref?: Ref<SideConversationHandle>;
  client: RpcClient;
  open: boolean;
  workspace: Workspace | null;
  sourceSessionId: string | null;
  onClose: () => void;
  onSideSessionChange?: (sessionId: string | null) => void | Promise<void>;
  idleMs?: number;
}

export interface SideConversationHandle {
  sendMessage: (request: { sourceSessionId: string; content: string; attachments: string[] }) => Promise<boolean>;
  focus: () => void;
}

interface SessionSnapshot { session: Session; messages: Message[]; streamingText?: string; streamingReasoning?: string; fork?: SessionForkInfo }

const SIDE_WIDTH_KEY = "miniq.sideConversationWidth";
const SIDE_WIDTH_DEFAULT = 380;
const SIDE_WIDTH_MIN = 300;
const SIDE_WIDTH_MAX = 760;

function storedWidth(): number {
  const stored = localStorage.getItem(SIDE_WIDTH_KEY);
  if (stored === null) return SIDE_WIDTH_DEFAULT;
  const value = Number(stored);
  if (!Number.isFinite(value)) return SIDE_WIDTH_DEFAULT;
  return Math.min(SIDE_WIDTH_MAX, Math.max(SIDE_WIDTH_MIN, Math.round(value)));
}

function uniquePaths(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming])];
}

export function SideConversationPanel({ ref, client, open, workspace, sourceSessionId, onClose, onSideSessionChange, idleMs = SIDE_CONVERSATION_IDLE_MS }: Props) {
  const [conversation, setConversation] = useState<SideConversationState>(EMPTY_SIDE_CONVERSATION);
  const [sideSession, setSideSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkInfo, setForkInfo] = useState<SessionForkInfo | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(storedWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const fileInput = useRef<HTMLInputElement>(null);
  const storageKey = sideConversationStorageKey(client.sshHost ?? null);
  const workspacePaths = useMemo(() => workspace
    ? [workspace.path, ...workspace.additionalPaths]
    : [], [workspace]);
  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const refresh = async (sessionId: string) => {
    const snapshot = await client.call<SessionSnapshot>("session.open", { sessionId, limit: 50, view: "visible" });
    if (conversationRef.current.sessionId !== sessionId) return;
    setSideSession(snapshot.session);
    setMessages(snapshot.messages ?? []);
    setStreamingText(snapshot.streamingText ?? "");
    setStreamingReasoning(snapshot.streamingReasoning ?? "");
    if (snapshot.fork) setForkInfo(snapshot.fork);
  };
  const release = async () => {
    const current = conversationRef.current;
    if (!current.sessionId) return;
    try {
      const released = await releaseSideConversation(client, current, { cancel: busyRef.current });
      conversationRef.current = released;
      setConversation(released);
      setSideSession(null);
      setMessages([]); setStreamingText(""); setStreamingReasoning(""); setBusy(false); setError(null); setForkInfo(null); setAttachments([]);
      await onSideSessionChange?.(null);
    } catch (cause) { setError(errorMessage(cause)); }
  };

  // Hiding the panel, switching main conversations or quitting must not delete the
  // side chat: only the delete button or the idle deadline ends it.
  useEffect(() => client.onEvent((event) => {
    const sessionId = conversationRef.current.sessionId;
    if (!sessionId) return;
    if ("sessionId" in event && event.sessionId === sessionId) {
      if (event.type === "assistant_delta") setStreamingText((text) => text + event.delta);
      if (event.type === "assistant_replaced") setStreamingText(event.text);
      if (event.type === "assistant_reasoning_delta") setStreamingReasoning((text) => text + event.delta);
      if (event.type === "assistant_reasoning_replaced") setStreamingReasoning(event.text);
      if (event.type === "message_created") {
        setMessages((messages) => messages.some((message) => message.id === event.message.id) ? messages : [...messages, event.message]);
        if (event.message.role === "assistant") { setStreamingText(""); setStreamingReasoning(""); }
      }
    }
    if (event.type === "session_status_changed") {
      if (event.sessionId !== sessionId) return;
      busyRef.current = event.status === "running" || event.status === "cancelling";
      setBusy(busyRef.current);
    }
    if (event.type === "turn_completed" || event.type === "turn_failed") {
      if (event.sessionId !== sessionId) return;
      busyRef.current = false;
      setBusy(false);
      void refresh(sessionId).catch((cause) => setError(errorMessage(cause)));
    }
  }), [client]);

  // Expired records are cleaned even when the panel never reopens, so abandoned
  // side sessions cannot pile up on the desktop.
  useEffect(() => {
    const stored = readStoredSideConversation(storageKey);
    if (!stored?.sessionId || !isSideConversationExpired(stored, Date.now(), idleMs)) return;
    clearStoredSideConversation(storageKey);
    void releaseSideConversation(client, stored, { cancel: true }).catch(() => undefined);
  }, [client, idleMs, storageKey]);

  useEffect(() => {
    if (!open || conversationRef.current.sessionId) return;
    const stored = readStoredSideConversation(storageKey);
    if (!stored?.sessionId) return;
    conversationRef.current = stored;
    setConversation(stored);
    onSideSessionChange?.(stored.sessionId);
    void refresh(stored.sessionId).catch(() => {
      // The stored side session is gone on this host; drop the local record.
      clearStoredSideConversation(storageKey);
      conversationRef.current = EMPTY_SIDE_CONVERSATION;
      setConversation(EMPTY_SIDE_CONVERSATION);
      setSideSession(null);
      onSideSessionChange?.(null);
    });
  }, [client, storageKey, open]);

  useEffect(() => {
    if (conversation.sessionId) storeSideConversation(storageKey, conversation);
    else clearStoredSideConversation(storageKey);
  }, [conversation, storageKey]);

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
    setAttachments(uniquePaths(attachmentsRef.current, paths));
  };
  useDroppedFiles(textareaRef, addAttachments, setError);

  const pickFiles = async () => {
    if (busy) return;
    if (!isTauriRuntime()) {
      // Remote and mobile clients stage the file through the daemon instead.
      fileInput.current?.click();
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
    try {
      if (isTauriRuntime()) {
        addAttachments(await Promise.all(files.map((file) => savePastedFile(file))));
        return;
      }
      // Pasting a screenshot on a phone or remote client uploads it to the desktop first.
      const target = conversationRef.current.sessionId ?? sourceSessionId;
      if (!target) { setError("先打开一个对话，再附加文件"); return; }
      const uploaded: string[] = [];
      for (const file of files) {
        const receipt = await uploadRemoteFile(client, { sessionId: target }, file);
        if (!receipt?.path) throw new Error("上传未完成，请重试");
        uploaded.push(receipt.path);
      }
      addAttachments(uploaded);
    } catch (cause) { setError(`无法附加文件: ${errorMessage(cause)}`); }
  };

  const sendMessage = async (content: string, files: string[], source: string | null): Promise<boolean> => {
    if (busyRef.current) { setError("侧边聊天正在处理，请稍后重试"); return false; }
    if (!canSendComposer(content, files) || !workspace) return false;
    if (!source) { setError("先打开一个对话，再开始侧边聊天"); return false; }
    busyRef.current = true;
    setBusy(true); setError(null);
    let optimisticId: string | null = null;
    try {
      let current = conversationRef.current;
      if (!current.sessionId) {
        const stored = readStoredSideConversation(storageKey);
        if (stored?.sessionId && !isSideConversationExpired(stored, Date.now(), idleMs)) {
          current = stored;
          conversationRef.current = current;
          setConversation(current);
          onSideSessionChange?.(current.sessionId);
          await refresh(stored.sessionId);
        }
      }
      if (!current.sessionId) {
        const session = await client.call<Session>("session.fork", { sessionId: source, mode: "side" });
        current = createSideConversationState(session, source);
        conversationRef.current = current;
        setConversation(current);
        setSideSession(session);
        onSideSessionChange?.(session.id);
        const snapshot = await client.call<SessionSnapshot>("session.open", { sessionId: session.id, limit: 50, view: "visible" });
        if (snapshot.fork) setForkInfo(snapshot.fork);
      }
      const optimistic: Message = { id: `side-user-${Date.now()}`, sessionId: current.sessionId!, role: "user", content, createdAt: new Date().toISOString() };
      optimisticId = optimistic.id;
      setMessages((items) => [...items, optimistic]);
      await client.call("session.sendMessage", { sessionId: current.sessionId, message: { role: "user", content, attachments: files }, rejectIfBusy: true });
      const activeConversation = { ...current, lastActivityAt: Date.now() };
      conversationRef.current = activeConversation;
      setConversation(activeConversation);
      // Once accepted, a snapshot failure must not invite resending the same question.
      await refresh(current.sessionId!).catch((cause) => setError(errorMessage(cause)));
      return true;
    } catch (cause) {
      if (optimisticId) setMessages((items) => items.filter((item) => item.id !== optimisticId));
      busyRef.current = false;
      setBusy(false); setError(errorMessage(cause));
      return false;
    }
  };

  const send = async () => {
    if (await sendMessage(draft.trim(), attachmentsRef.current, sourceSessionId)) {
      setDraft(""); setAttachments([]);
    }
  };

  useImperativeHandle(ref, () => ({
    sendMessage: (request) => sendMessage(request.content, request.attachments, request.sourceSessionId),
    focus: () => textareaRef.current?.focus(),
  }));

  const commitWidth = (nextWidth: number) => {
    setDragWidth(null);
    setPreferredWidth(nextWidth);
    localStorage.setItem(SIDE_WIDTH_KEY, String(nextWidth));
  };

  if (!open) return null;
  const canCompose = !!workspace && !!sourceSessionId && !busy;
  const width = dragWidth ?? preferredWidth;
  const workspacePath = sideSession?.workingDirectory ?? workspace?.path;
  return <SessionFileAccess client={client} sessionId={conversation.sessionId ?? sourceSessionId}
    workspacePath={workspacePath} workspacePaths={workspacePaths}>
    <aside className="side-conversation" style={{ width, flexBasis: width }} aria-label="侧边聊天">
    <WorkbenchResizer
      edge="left"
      label="调整侧边聊天宽度"
      width={width}
      min={SIDE_WIDTH_MIN}
      max={SIDE_WIDTH_MAX}
      onResize={setDragWidth}
      onCommit={commitWidth}
      onCancel={() => setDragWidth(null)}
      onReset={() => commitWidth(SIDE_WIDTH_DEFAULT)}
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
      {messages.length === 0 && !streamingText && !streamingReasoning && <p className="side-conversation-empty">
        {forkInfo
          ? `已继承 ${forkInfo.inheritedMessageCount} 条上下文，可以开始追问。`
          : sourceSessionId ? "可在这里快速追问，不打断主会话。" : "先在主对话里打开一个会话。"}
      </p>}
      {messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => <article key={message.id} data-role={message.role}>
        <span>{message.role === "user" ? "你" : "miniQ"}</span>
        {message.role === "assistant" && <DeepThinking text={message.reasoning} />}<Md workspacePath={workspacePath}>{message.content}</Md>
        {!!message.attachments?.length && (
          <div className="message-attachments">
            {message.attachments.map((attachment) => (
              <MessageAttachmentPreview key={attachment.path} attachment={attachment} />
            ))}
          </div>
        )}
      </article>)}
      {(streamingText || streamingReasoning) && <article data-role="assistant"><span>miniQ</span>
        <DeepThinking text={streamingReasoning} streaming={busy && !streamingText} /><Md workspacePath={workspacePath} streaming>{streamingText}</Md></article>}
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
      <input ref={fileInput} type="file" hidden multiple aria-label="选择要附加的文件或图片" onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        if (files.length > 0) void pasteFiles(files);
      }} />
      <button type="submit" aria-label="发送侧边聊天" title="发送 (⌘/Ctrl+Enter)" disabled={!canCompose || !canSendComposer(draft, attachments)}>{busy ? <Loader2 size={16} /> : <ArrowUp size={16} />}</button>
    </form>
  </aside></SessionFileAccess>;
}
