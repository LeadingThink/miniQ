import {
  Activity,
  ArrowDown,
  Check,
  ChevronUp,
  Download,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Artifact,
  Message,
  MessageAttachment,
  PlanTask,
  Question,
  QueuedMessage,
  ToolCall,
  TurnProgress,
} from "../types";
import type { PendingApproval } from "../App";
import { readImagePreview, type LocalFileTarget } from "../localFiles";
import { ApprovalCard, ArtifactsBar } from "./TimelineInteractions";
import { QueueBar, type QueueActions } from "./QueueBar";
import { QuestionCard, type QuestionCardProps } from "./QuestionCard";
import { Md } from "./Md";
import { ExecutionPrelude, PlanProgress } from "./ExecutionActivity";
import {
  createTimelineItems,
  groupTimeline,
  filterTimelineGroups,
  type TimelineFilter,
  type TimelineGroup,
} from "../timelineModel";
import { downloadSession } from "../sessionExport";
import { CopyButton } from "./CopyButton";
import { ToolGroup } from "./ToolGroup";
import type { RpcClient } from "../rpc";
import { useHistorySearch } from "../hooks/useHistorySearch";
import { readExportHistory } from "../historyExport";
import { ExecutionSummary } from "./ExecutionSummary";
import { ModelDiagnostics } from "./ModelDiagnostics";

function MessageAttachmentPreview({
  attachment,
}: {
  attachment: MessageAttachment;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const isImage = Boolean(attachment.mimeType?.startsWith("image/"));

  useEffect(() => {
    if (!isImage) return;
    let disposed = false;
    void readImagePreview(attachment.path)
      .then((preview) => {
        if (!disposed)
          setImageUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
      })
      .catch(() => {
        if (!disposed) setImageUrl(null);
      });
    return () => {
      disposed = true;
    };
  }, [attachment.path, isImage]);

  if (imageUrl) {
    return (
      <img
        className="message-attachment-image"
        src={imageUrl}
        alt={attachment.name}
      />
    );
  }
  return <span className="message-attachment-file">{attachment.name}</span>;
}

interface TimelineProps {
  workspacePaths?: readonly string[];
  client?: RpcClient;
  sessionId?: string;
  loading?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
  title?: string;
  messages: Message[];
  toolCalls: ToolCall[];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  artifacts: Artifact[];
  queue: QueuedMessage[];
  workspacePath?: string | null;
  streamingText: string;
  turnProgress: TurnProgress | null;
  busy: boolean;
  onResolveApproval: (approvalId: string, decision: string) => void;
  onResolveQuestion: QuestionCardProps["onResolve"];
  onRollback: (checkpointId: string) => void;
  onOpenFile: (target: LocalFileTarget) => void;
  onOpenUrl: (url: string) => void;
  onSteerQueued: QueueActions["onSteer"];
  onRemoveQueued: QueueActions["onRemove"];
  onUpdateQueued: QueueActions["onUpdate"];
  onRewrite: (
    messageId: string,
    content: string,
    attachments?: string[],
  ) => Promise<boolean>;
  onError: (message: string) => void;
}

function TimelineEntries(props: {
  client?: RpcClient;
  items: TimelineGroup[];
  messages: Message[];
  expandGroups: boolean;
  onError: TimelineProps["onError"];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  streamingText: string;
  turnProgress: TurnProgress | null;
  thinking: boolean;
  busy: boolean;
  onResolveApproval: TimelineProps["onResolveApproval"];
  onResolveQuestion: TimelineProps["onResolveQuestion"];
  onRollback: TimelineProps["onRollback"];
  onOpenFile: TimelineProps["onOpenFile"];
  onOpenUrl: TimelineProps["onOpenUrl"];
  onRewrite: TimelineProps["onRewrite"];
  workspacePath?: string | null;
}) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const startEditing = (message: Message) => {
    if (props.busy) return;
    setEditingMessageId(message.id);
    setDraft(message.content);
  };
  const cancelEditing = () => {
    setEditingMessageId(null);
    setDraft("");
  };
  const saveMessage = async (message: Message) => {
    const content = draft.trim();
    if (!content || saving || props.busy) return;
    setSaving(true);
    try {
      const sent = await props.onRewrite(
        message.id,
        content,
        message.attachments?.map((attachment) => attachment.path),
      );
      if (sent) cancelEditing();
    } catch (cause) {
      props.onError(`重新发送消息失败: ${String(cause)}`);
    } finally {
      setSaving(false);
    }
  };
  const regenerateMessage = async (message: Message) => {
    const messageIndex = props.messages.findIndex(
      (candidate) => candidate.id === message.id,
    );
    let userMessage: Message | undefined;
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      if (props.messages[index].role === "user") {
        userMessage = props.messages[index];
        break;
      }
    }
    if (!userMessage) {
      props.onError("找不到这条回复对应的用户消息");
      return;
    }
    try {
      await props.onRewrite(
        userMessage.id,
        userMessage.content,
        userMessage.attachments?.map((attachment) => attachment.path),
      );
    } catch (cause) {
      props.onError(`重新生成回复失败: ${String(cause)}`);
    }
  };

  return (
    <div className="timeline-inner">
      {props.items.map((item) =>
        item.kind === "message" ? (
          item.message.role === "user" ? (
            <div
              key={item.message.id}
              className="bubble user"
              title={new Date(item.message.createdAt).toLocaleString()}
            >
              {editingMessageId === item.message.id ? (
                <textarea
                  className="message-edit-input"
                  aria-label="修改消息内容"
                  value={draft}
                  autoFocus
                  rows={Math.max(2, draft.split("\n").length)}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") cancelEditing();
                    if (
                      event.key === "Enter" &&
                      (event.ctrlKey || event.metaKey)
                    )
                      void saveMessage(item.message);
                  }}
                />
              ) : item.message.content ? (
                <div>{item.message.content}</div>
              ) : null}
              {item.message.attachments &&
                item.message.attachments.length > 0 && (
                  <div className="message-attachments">
                    {item.message.attachments.map((attachment) => (
                      <MessageAttachmentPreview
                        key={attachment.path}
                        attachment={attachment}
                      />
                    ))}
                  </div>
                )}
              <div className="message-actions">
                {editingMessageId === item.message.id ? (
                  <>
                    <button
                      type="button"
                      className="msg-action"
                      title="发送修改"
                      aria-label="发送修改"
                      disabled={!draft.trim() || saving || props.busy}
                      onClick={() => void saveMessage(item.message)}
                    >
                      {saving ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <Check size={15} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="msg-action"
                      title="取消修改"
                      aria-label="取消修改"
                      onClick={cancelEditing}
                    >
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <CopyButton
                      className="msg-copy"
                      label="复制消息"
                      content={item.message.content}
                      onError={props.onError}
                    />
                    <button
                      type="button"
                      className="msg-action"
                      title="修改消息"
                      aria-label="修改消息"
                      disabled={props.busy}
                      onClick={() => startEditing(item.message)}
                    >
                      <Pencil size={15} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : item.message.role === "tool" ? (
            <div key={item.message.id} className="bubble tool-transcript">
              <span>工具记录</span>
              <Md
                workspacePath={props.workspacePath}
                onOpenFile={props.onOpenFile}
                onOpenUrl={props.onOpenUrl}
              >
                {item.message.content}
              </Md>
            </div>
          ) : (
            <div
              key={item.message.id}
              className="bubble assistant"
              title={new Date(item.message.createdAt).toLocaleString()}
            >
              <Md
                workspacePath={props.workspacePath}
                onOpenFile={props.onOpenFile}
                onOpenUrl={props.onOpenUrl}
              >
                {item.message.content}
              </Md>
              <div className="message-actions assistant-actions">
                <CopyButton
                  className="msg-copy"
                  label="复制消息"
                  content={item.message.content}
                  onError={props.onError}
                />
                <button
                  type="button"
                  className="msg-action"
                  title="重新生成"
                  aria-label="重新生成"
                  disabled={props.busy}
                  onClick={() => void regenerateMessage(item.message)}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
            </div>
          )
        ) : (
          <ToolGroup
            key={item.calls[0].id}
            calls={item.calls}
            onRollback={props.onRollback}
            expanded={props.expandGroups}
            client={props.client}
          />
        ),
      )}
      {props.approvals.map((approval) => (
        <ApprovalCard
          key={approval.approval.id}
          item={approval}
          onResolve={props.onResolveApproval}
        />
      ))}
      {props.questions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          onResolve={props.onResolveQuestion}
          workspacePath={props.workspacePath}
          onOpenFile={props.onOpenFile}
          onOpenUrl={props.onOpenUrl}
        />
      ))}
      {props.streamingText && (
        <div className="bubble assistant">
          <Md
            workspacePath={props.workspacePath}
            onOpenFile={props.onOpenFile}
            onOpenUrl={props.onOpenUrl}
          >
            {props.streamingText}
          </Md>
          <span className="type-cursor" />
        </div>
      )}
      {props.thinking && (
        <ExecutionPrelude plan={props.plan} progress={props.turnProgress} />
      )}
      <PlanProgress plan={props.plan} busy={props.busy} />
    </div>
  );
}

export function Timeline(props: TimelineProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [query, setQuery] = useState("");
  const historySearch = useHistorySearch(
    props.client,
    props.sessionId,
    filter,
    query,
  );
  const [exporting, setExporting] = useState(false);
  const exportRequest = useRef<AbortController | null>(null);
  const scrollAnchor = useRef<{ top: number; height: number } | null>(null);
  useEffect(() => () => exportRequest.current?.abort(), []);
  const exportSession = async (format: "md" | "json") => {
    if (exportRequest.current) return;
    const request = new AbortController();
    exportRequest.current = request;
    setExporting(true);
    try {
      const history =
        props.client && props.sessionId
          ? await readExportHistory(
              props.client,
              props.sessionId,
              request.signal,
            )
          : { messages: props.messages, toolCalls: props.toolCalls };
      if (!request.signal.aborted)
        downloadSession(
          {
            title: props.title ?? "miniQ session",
            ...history,
            plan: props.plan,
            artifacts: props.artifacts,
          },
          format,
        );
    } catch (cause) {
      if (!request.signal.aborted) props.onError(`导出失败: ${String(cause)}`);
    } finally {
      if (exportRequest.current === request) {
        exportRequest.current = null;
        setExporting(false);
      }
    }
  };

  // Track whether the user is reading history (not pinned to bottom).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    pinnedToBottom.current = nearBottom;
    setShowJump(!nearBottom);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    pinnedToBottom.current = true;
    setShowJump(false);
  };

  // Auto-follow only while pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [
    props.messages,
    props.toolCalls,
    props.approvals,
    props.questions,
    props.plan,
    props.streamingText,
    props.turnProgress,
    props.busy,
    props.queue,
  ]);

  const groups = useMemo(
    () => groupTimeline(createTimelineItems(props.messages, props.toolCalls)),
    [props.messages, props.toolCalls],
  );
  const items = useMemo(
    () =>
      historySearch.enabled
        ? groupTimeline(
            createTimelineItems(
              historySearch.page?.messages ?? [],
              historySearch.page?.toolCalls ?? [],
            ),
          )
        : filterTimelineGroups(groups, filter, query),
    [groups, filter, query, historySearch.enabled, historySearch.page],
  );
  useEffect(() => {
    const el = scrollRef.current;
    const anchor = scrollAnchor.current;
    if (!el || !anchor) return;
    el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
    scrollAnchor.current = null;
  }, [items]);
  const hasOlder = historySearch.enabled
    ? Boolean(historySearch.page?.nextCursor)
    : props.hasOlder;
  const loadingOlder = historySearch.enabled
    ? historySearch.loading
    : props.loadingOlder;
  const loadOlder = () => {
    const el = scrollRef.current;
    if (el)
      scrollAnchor.current = { top: el.scrollTop, height: el.scrollHeight };
    pinnedToBottom.current = false;
    if (historySearch.enabled) historySearch.loadOlder();
    else void props.onLoadOlder?.();
  };
  const hasRunningTool = props.toolCalls.some(
    (t) => t.status === "running" || t.status === "waiting_approval",
  );
  const thinking =
    !props.loading &&
    props.busy &&
    (!hasRunningTool || !!props.turnProgress?.retry) &&
    props.approvals.length === 0 &&
    props.questions.length === 0;

  return (
    <>
      <ExecutionSummary
        messages={props.messages}
        calls={props.toolCalls}
        progress={props.turnProgress}
        plan={props.plan}
        busy={props.busy}
        approvals={props.approvals.length}
        questions={props.questions.length}
      />
      <div className="timeline-toolbar" aria-label="会话记录工具栏">
        {props.client && props.sessionId && (
          <button
            type="button"
            className="icon-button"
            title="模型调用记录"
            aria-label="模型调用记录"
            onClick={() => setShowDiagnostics(true)}
          >
            <Activity size={16} />
          </button>
        )}
        <div className="timeline-modes" role="group" aria-label="记录类型">
          {(
            [
              ["all", "全部"],
              ["answers", "回答"],
              ["activity", "执行"],
              ["errors", "异常"],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="timeline-search">
          <Search size={14} />
          <input
            type="search"
            aria-label="搜索当前会话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="icon-button"
              title="清空会话搜索"
              aria-label="清空会话搜索"
              onClick={() => setQuery("")}
            >
              <X size={13} />
            </button>
          )}
        </label>
        <details className="session-export">
          <summary title="导出会话" aria-label="导出会话">
            {exporting ? (
              <LoaderCircle size={16} className="activity-spinner" />
            ) : (
              <Download size={16} />
            )}
          </summary>
          <div>
            {(["md", "json"] as const).map((format) => (
              <button
                type="button"
                key={format}
                disabled={exporting}
                onClick={() => void exportSession(format)}
              >
                {format === "md" ? "Markdown" : "JSON"}
              </button>
            ))}
          </div>
        </details>
      </div>
      {showDiagnostics && props.client && props.sessionId && (
        <ModelDiagnostics
          client={props.client}
          sessionId={props.sessionId}
          onClose={() => setShowDiagnostics(false)}
        />
      )}
      <div className="timeline" ref={scrollRef} onScroll={onScroll}>
        {(props.loading || (historySearch.loading && !historySearch.page)) && (
          <div className="history-loading" role="status">
            <LoaderCircle size={16} className="activity-spinner" />
            正在加载会话
          </div>
        )}
        {historySearch.error && (
          <div className="history-loading" role="alert">
            {historySearch.error}
            <button
              type="button"
              className="icon-button"
              title="重试搜索"
              aria-label="重试搜索"
              onClick={historySearch.retry}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        )}
        {hasOlder && (
          <div className="history-pages">
            <button
              type="button"
              className="ghost"
              disabled={loadingOlder}
              onClick={loadOlder}
            >
              {loadingOlder ? (
                <LoaderCircle size={14} className="activity-spinner" />
              ) : (
                <ChevronUp size={14} />
              )}
              更早的记录
            </button>
          </div>
        )}
        {!props.loading &&
          !historySearch.loading &&
          !historySearch.error &&
          items.length === 0 &&
          (filter !== "all" || query) && (
            <div className="diff-empty" role="status">
              没有匹配的记录
            </div>
          )}
        <TimelineEntries
          client={props.client}
          items={items}
          messages={props.messages}
          expandGroups={filter !== "all" || !!query}
          onError={props.onError}
          approvals={props.approvals}
          questions={props.questions}
          plan={props.plan}
          streamingText={props.streamingText}
          turnProgress={props.turnProgress}
          thinking={thinking}
          busy={props.busy}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onRollback={props.onRollback}
          onOpenFile={props.onOpenFile}
          onOpenUrl={props.onOpenUrl}
          onRewrite={props.onRewrite}
          workspacePath={props.workspacePath}
        />
        <QueueBar
          key={props.sessionId}
          queue={props.queue}
          onSteer={props.onSteerQueued}
          onRemove={props.onRemoveQueued}
          onUpdate={props.onUpdateQueued}
        />
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-to-bottom"
          title="回到底部"
          aria-label="回到底部"
          onClick={jumpToBottom}
        >
          <ArrowDown size={15} />
        </button>
      )}
      <ArtifactsBar
        workspacePaths={props.workspacePaths}
        artifacts={props.artifacts}
        workspacePath={props.workspacePath}
        onOpenFile={props.onOpenFile}
        onError={props.onError}
      />
    </>
  );
}
