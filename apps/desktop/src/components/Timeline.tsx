import {
  ArrowDown,
  ChevronUp,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Artifact,
  AnchoredTurnTiming,
  HistoryCursor,
  Message,
  PlanTask,
  Question,
  QueuedMessage,
  ToolCall,
  TurnProgress,
} from "../types";
import type { PendingApproval } from "../App";
import type { LocalFileTarget } from "../localFiles";
import { QueueBar, type QueueActions } from "./QueueBar";
import type { QuestionCardProps } from "./QuestionCard";
import {
  groupTimeline,
  filterTimelineGroups,
  itemMatches,
  type TimelineFilter,
  createTimelineItemsWithArtifacts,
} from "../timelineModel";
import { downloadSession } from "../sessionExport";
import type { RpcClient } from "../rpc";
import { useHistorySearch } from "../hooks/useHistorySearch";
import { readExportHistory } from "../historyExport";
import { ExecutionSummary } from "./ExecutionSummary";
import { ModelDiagnostics } from "./ModelDiagnostics";
import { SessionShareDialog } from "./SessionShareDialog";
import { ConversationNavigationRail } from "./ConversationNavigationRail";
import { useConversationScroll } from "../hooks/useConversationScroll";
import { TimelineEntries } from "./TimelineEntries";
import { TimelineToolbar } from "./TimelineToolbar";
import { AgentStatusIndicator, type AgentSummary } from "./AgentSummary";

export interface TimelineProps {
  workspacePaths?: readonly string[];
  client?: RpcClient;
  sessionId?: string;
  loading?: boolean;
  historyCursor?: HistoryCursor | null;
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
  latestTurnTiming?: AnchoredTurnTiming | null;
  busy: boolean;
  agents?: AgentSummary[];
  onOpenAgentPanel?: () => void;
  onResolveApproval: (approvalId: string, decision: string) => void;
  onResolveQuestion: QuestionCardProps["onResolve"];
  onRollback: (checkpointId: string) => void;
  onOpenFile: (target: LocalFileTarget) => void;
  onOpenUrl: (url: string) => void;
  onSteerQueued: QueueActions["onSteer"];
  onRemoveQueued: QueueActions["onRemove"];
  onUpdateQueued: QueueActions["onUpdate"];
  onMoveQueued?: QueueActions["onMove"];
  onRewrite: (
    messageId: string,
    content: string,
    attachments?: string[],
  ) => Promise<boolean>;
  onError: (message: string) => void;
}

export function Timeline(props: TimelineProps) {
  const [showShare, setShowShare] = useState(false);
  useEffect(() => setShowShare(false), [props.sessionId]);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
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

  const groups = useMemo(
    () =>
      groupTimeline(
        createTimelineItemsWithArtifacts(
          props.messages,
          props.toolCalls,
          props.artifacts,
          { hasOlder: Boolean(props.historyCursor) },
        ),
      ),
    [props.messages, props.toolCalls, props.artifacts, props.historyCursor],
  );
  const items = useMemo(
    () =>
      historySearch.enabled
        ? groupTimeline(
            createTimelineItemsWithArtifacts(
              // These records already matched the server's full-text search.
              // Deferred tool payloads cannot be searched again locally.
              historySearch.page?.messages ?? [],
              historySearch.page?.toolCalls ?? [],
              props.artifacts.filter((artifact) =>
                itemMatches({ kind: "artifact", at: artifact.createdAt, artifact }, filter, query),
              ),
            ),
          )
        : filterTimelineGroups(groups, filter, query),
    [groups, filter, query, historySearch.enabled, historySearch.page, props.artifacts],
  );
  const historyCursor = historySearch.enabled
    ? historySearch.page?.nextCursor
    : props.historyCursor;
  const hasOlder = Boolean(historyCursor);
  const loadingOlder = historySearch.enabled
    ? historySearch.loading
    : props.loadingOlder;
  const contentVersion = useMemo(() => [
    items, props.approvals, props.questions, props.plan, props.streamingText,
    props.turnProgress, props.busy, props.queue,
  ], [items, props.approvals, props.questions, props.plan, props.streamingText,
    props.turnProgress, props.busy, props.queue]);
  const { scrollRef, historyTopRef, onScroll, loadOlder, jumpToBottom, showJump } = useConversationScroll({
    viewKey: JSON.stringify([props.sessionId, filter, query.trim()]),
    cursorKey: historyCursor ? JSON.stringify(historyCursor) : null,
    autoLoadOlder: props.client?.mode !== "remote",
    hasOlder,
    loadingOlder,
    loading: props.loading || (historySearch.loading && !historySearch.page),
    loadOlder: historySearch.enabled ? historySearch.loadOlder : props.onLoadOlder,
    contentVersion,
  });
  const navigationMessages = useMemo(
    () => items.flatMap((item) => item.kind === "message" ? [item.message] : []),
    [items],
  );
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
        timing={props.latestTurnTiming}
      />
      {props.agents && props.onOpenAgentPanel && (
        <AgentStatusIndicator
          agents={props.agents}
          onOpen={props.onOpenAgentPanel}
        />
      )}
      <TimelineToolbar
        key={props.sessionId}
        filter={filter}
        query={query}
        exporting={exporting}
        onFilter={setFilter}
        onQuery={setQuery}
        onShare={props.client && props.sessionId ? () => setShowShare(true) : undefined}
        onDiagnostics={props.client && props.sessionId ? () => setShowDiagnostics(true) : undefined}
        onExport={(format) => void exportSession(format)}
      />
      {showDiagnostics && props.client && props.sessionId && (
        <ModelDiagnostics
          client={props.client}
          sessionId={props.sessionId}
          onClose={() => setShowDiagnostics(false)}
        />
      )}
      {showShare && props.client && props.sessionId && <SessionShareDialog client={props.client} sessionId={props.sessionId} title={props.title ?? "miniQ 会话"} artifacts={props.artifacts} onClose={() => setShowShare(false)} />}
      <div className="timeline-shell">
        <ConversationNavigationRail messages={navigationMessages} scrollRef={scrollRef} />
        <div className="timeline" ref={scrollRef} onScroll={onScroll}>
          <div ref={historyTopRef} className="history-top-sentinel" aria-hidden="true" />
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
          key={props.sessionId}
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
          latestTurnTiming={props.latestTurnTiming}
          thinking={thinking}
          busy={props.busy}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onRollback={props.onRollback}
          onOpenFile={props.onOpenFile}
          onOpenUrl={props.onOpenUrl}
          onRewrite={props.onRewrite}
          workspacePath={props.workspacePath}
          workspacePaths={props.workspacePaths}
        />
          <QueueBar
            key={props.sessionId}
            queue={props.queue}
            onSteer={props.onSteerQueued}
            onRemove={props.onRemoveQueued}
            onUpdate={props.onUpdateQueued}
            onMove={props.onMoveQueued}
          />
        </div>
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
    </>
  );
}
