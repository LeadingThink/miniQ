import { ArrowDown, ChevronUp, Download, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
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
import { ApprovalCard, QuestionCard, QueueBar, ArtifactsBar } from "./TimelineInteractions";
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

function MessageAttachmentPreview({ attachment }: { attachment: MessageAttachment }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const isImage = Boolean(attachment.mimeType?.startsWith("image/"));

  useEffect(() => {
    if (!isImage) return;
    let disposed = false;
    void readImagePreview(attachment.path)
      .then((preview) => {
        if (!disposed) setImageUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
      })
      .catch(() => {
        if (!disposed) setImageUrl(null);
      });
    return () => {
      disposed = true;
    };
  }, [attachment.path, isImage]);

  if (imageUrl) {
    return <img className="message-attachment-image" src={imageUrl} alt={attachment.name} />;
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
  onResolveQuestion: (questionId: string, answer: string) => void;
  onRollback: (checkpointId: string) => void;
  onOpenFile: (target: LocalFileTarget) => void;
  onOpenUrl: (url: string) => void;
  onSteerQueued: (queuedMessageId: string) => void;
  onRemoveQueued: (queuedMessageId: string) => void;
  onError: (message: string) => void;
}

function TimelineEntries(props: {
  client?: RpcClient;
  items: TimelineGroup[];
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
  workspacePath?: string | null;
}) {
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
              {item.message.content && <div>{item.message.content}</div>}
              {item.message.attachments && item.message.attachments.length > 0 && (
                <div className="message-attachments">
                  {item.message.attachments.map((attachment) => (
                    <MessageAttachmentPreview key={attachment.path} attachment={attachment} />
                  ))}
                </div>
              )}
              <CopyButton
                className="msg-copy"
                label="复制消息"
                content={item.message.content}
                onError={props.onError}
              />
            </div>
          ) : item.message.role === "tool" ? (
            <div key={item.message.id} className="bubble tool-transcript">
              <span>工具记录</span>
              <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile} onOpenUrl={props.onOpenUrl}>
                {item.message.content}
              </Md>
            </div>
          ) : (
            <div
              key={item.message.id}
              className="bubble assistant"
              title={new Date(item.message.createdAt).toLocaleString()}
            >
              <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile} onOpenUrl={props.onOpenUrl}>
                {item.message.content}
              </Md>
              <CopyButton
                className="msg-copy"
                label="复制消息"
                content={item.message.content}
                onError={props.onError}
              />
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
        <ApprovalCard key={approval.approval.id} item={approval} onResolve={props.onResolveApproval} />
      ))}
      {props.questions.map((question) => (
        <QuestionCard key={question.id} question={question} onResolve={props.onResolveQuestion} />
      ))}
      {props.streamingText && (
        <div className="bubble assistant">
          <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile} onOpenUrl={props.onOpenUrl}>
            {props.streamingText}
          </Md>
          <span className="type-cursor" />
        </div>
      )}
      {props.thinking && <ExecutionPrelude plan={props.plan} progress={props.turnProgress} />}
      <PlanProgress plan={props.plan} busy={props.busy} />
    </div>
  );
}

export function Timeline(props: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [query, setQuery] = useState("");
  const historySearch = useHistorySearch(props.client, props.sessionId, filter, query);
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
          ? await readExportHistory(props.client, props.sessionId, request.signal)
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
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
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
        ? groupTimeline(createTimelineItems(historySearch.page?.messages ?? [], historySearch.page?.toolCalls ?? []))
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
  const hasOlder = historySearch.enabled ? Boolean(historySearch.page?.nextCursor) : props.hasOlder;
  const loadingOlder = historySearch.enabled ? historySearch.loading : props.loadingOlder;
  const loadOlder = () => {
    const el = scrollRef.current;
    if (el) scrollAnchor.current = { top: el.scrollTop, height: el.scrollHeight };
    pinnedToBottom.current = false;
    if (historySearch.enabled) historySearch.loadOlder();
    else void props.onLoadOlder?.();
  };
  const hasRunningTool = props.toolCalls.some((t) => t.status === "running" || t.status === "waiting_approval");
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
        <div className="timeline-modes" role="group" aria-label="记录类型">
          {(
            [
              ["all", "全部"],
              ["answers", "回答"],
              ["activity", "执行"],
              ["errors", "异常"],
            ] as const
          ).map(([value, label]) => (
            <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
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
            {exporting ? <LoaderCircle size={16} className="activity-spinner" /> : <Download size={16} />}
          </summary>
          <div>
            {(["md", "json"] as const).map((format) => (
              <button type="button" key={format} disabled={exporting} onClick={() => void exportSession(format)}>
                {format === "md" ? "Markdown" : "JSON"}
              </button>
            ))}
          </div>
        </details>
      </div>
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
            <button type="button" className="ghost" disabled={loadingOlder} onClick={loadOlder}>
              {loadingOlder ? <LoaderCircle size={14} className="activity-spinner" /> : <ChevronUp size={14} />}
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
          workspacePath={props.workspacePath}
        />
        <QueueBar queue={props.queue} onSteer={props.onSteerQueued} onRemove={props.onRemoveQueued} />
      </div>
      {showJump && (
        <button type="button" className="jump-to-bottom" title="回到底部" aria-label="回到底部" onClick={jumpToBottom}>
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
