import { Spinner } from "./ui/Spinner";
import {
  ArrowDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchNavigation } from "../hooks/useSearchNavigation";
import { findHitElement, type SearchHit } from "../sessionSearch";
import { SessionSearchNavigator } from "./SessionSearchNavigator";
import type {
  Artifact,
  AnchoredTurnTiming,
  HistoryCursor,
  Message,
  PlanTask,
  TurnPlan,
  Question,
  QueuedMessage,
  SessionGoal,
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
import { saveSession } from "../sessionExport";
import { exportResultMessage, revealExportedFile } from "../saveExport";
import { useToast } from "./ui/Toast";
import type { RpcClient } from "../rpc";
import { useHistorySearch } from "../hooks/useHistorySearch";
import { readExportHistory } from "../historyExport";
import { ExecutionStatusBar } from "./ExecutionStatusBar";
import { ModelDiagnostics } from "./ModelDiagnostics";
import { SessionShareDialog } from "./SessionShareDialog";
import { ConversationNavigationRail } from "./ConversationNavigationRail";
import { useConversationScroll } from "../hooks/useConversationScroll";
import { TimelineEntries, type TimelineWindowHandle } from "./TimelineEntries";
import {
  SESSION_TOOLBAR_ACTION_EVENT,
  TimelineToolbar,
  type SessionToolbarActionDetail,
} from "./TimelineToolbar";
import { PendingApprovalBar } from "./PendingApprovalBar";
import { TimelineQuote } from "./TimelineQuote";
import { AgentStatusIndicator, type AgentSummary } from "./AgentSummary";

export interface TimelineProps {
  workspacePaths?: readonly string[];
  client?: RpcClient;
  sessionId?: string;
  loading?: boolean;
  historyCursor?: HistoryCursor | null;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void | { error: unknown }>;
  title?: string;
  messages: Message[];
  goal?: SessionGoal | null;
  toolCalls: ToolCall[];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  turnPlans?: TurnPlan[];
  artifacts: Artifact[];
  queue: QueuedMessage[];
  workspacePath?: string | null;
  streamingText: string;
  turnProgress: TurnProgress | null;
  latestTurnTiming?: AnchoredTurnTiming | null;
  busy: boolean;
  agents?: AgentSummary[];
  onOpenAgentPanel?: (agentId?: string) => void;
  summary?: ReactNode;
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
  onFork?: (anchorMessageId: string) => Promise<boolean>;
  /** Stop the running turn so an edit or regenerate can replace it. */
  onStopTurn?: () => Promise<void>;
  onError: (message: string) => void;
}

export function Timeline(props: TimelineProps) {
  const [showShare, setShowShare] = useState(false);
  useEffect(() => setShowShare(false), [props.sessionId]);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<SessionToolbarActionDetail>).detail;
      if (!detail || !props.client || !props.sessionId) return;
      if (detail.sessionId && detail.sessionId !== props.sessionId) return;
      if (detail.action === "share") setShowShare(true);
      else if (detail.action === "diagnostics") setShowDiagnostics(true);
    };
    window.addEventListener(SESSION_TOOLBAR_ACTION_EVENT, onAction);
    return () => window.removeEventListener(SESSION_TOOLBAR_ACTION_EVENT, onAction);
  }, [props.client, props.sessionId]);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [query, setQuery] = useState("");
  const historySearch = useHistorySearch(
    props.client,
    props.sessionId,
    filter,
    query,
  );
  const toast = useToast();
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
      if (request.signal.aborted) return;
      const result = await saveSession(
        {
          title: props.title ?? "miniQ session",
          ...history,
          plan: props.plan,
          artifacts: props.artifacts,
        },
        format,
      );
      const message = exportResultMessage(result);
      if (message)
        toast.show({
          message,
          tone: "success",
          duration: 8000,
          action:
            result.status === "saved"
              ? {
                  label: "在文件夹中显示",
                  onAction: () =>
                    void revealExportedFile(result.path).catch((cause) =>
                      props.onError(`无法定位文件: ${String(cause)}`),
                    ),
                }
              : undefined,
        });
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
    items, props.approvals, props.questions, props.plan, props.turnPlans, props.streamingText,
    props.turnProgress, props.busy, props.queue,
  ], [items, props.approvals, props.questions, props.plan, props.turnPlans, props.streamingText,
    props.turnProgress, props.busy, props.queue]);
  const { scrollRef, historyTopRef, onScroll, loadOlder, jumpToBottom, showJump, reveal, historyError, retryingOlder } = useConversationScroll({
    viewKey: JSON.stringify([props.sessionId, filter, query.trim()]),
    cursorKey: historyCursor ? JSON.stringify(historyCursor) : null,
    autoLoadOlder: true,
    hasOlder,
    loadingOlder,
    loading: props.loading || (historySearch.loading && !historySearch.page),
    loadOlder: historySearch.enabled ? historySearch.loadOlder : props.onLoadOlder,
    contentVersion,
  });
  const searching = filter !== "all" || !!query.trim();
  const navigation = useSearchNavigation({
    scrollRef,
    groups: items,
    enabled: searching,
    searchKey: JSON.stringify([props.sessionId, filter, query.trim()]),
    query,
    hasOlder,
    loadingOlder: Boolean(loadingOlder),
    loadOlder,
    reveal,
    contentVersion,
  });
  // "查看上下文" leaves search and finds the record in the full conversation,
  // loading older pages until it appears or history runs out.
  const [locating, setLocating] = useState<SearchHit | null>(null);
  const windowHandle = useRef<TimelineWindowHandle>(null);
  const [mountedForLocate, setMountedForLocate] = useState(0);
  useEffect(() => setLocating(null), [props.sessionId]);
  const onLocated = useCallback(() => setMountedForLocate((value) => value + 1), []);
  const locate = () => {
    if (!navigation.current) return;
    setLocating(navigation.current);
    setFilter("all");
    setQuery("");
  };
  useEffect(() => {
    if (!locating || searching) return;
    const root = scrollRef.current;
    if (!root || props.loading) return;
    const frame = requestAnimationFrame(() => {
      // A long conversation may have windowed the record's turn out.
      if (windowHandle.current?.mountRecord(locating.key)) {
        setMountedForLocate((value) => value + 1);
        return;
      }
      const element = findHitElement(root, locating);
      if (element) {
        // Lazy disclosures expose search keys before mounting their records.
        // Wait for the native toggle and React commit before positioning.
        if (element instanceof HTMLDetailsElement &&
          (!element.open || !element.querySelector(":scope > [data-lazy-body]"))) {
          element.open = true;
          setMountedForLocate((value) => value + 1);
          return;
        }
        reveal(element);
        element.setAttribute("data-search-located", "true");
        window.setTimeout(() => element.removeAttribute("data-search-located"), 1600);
        setLocating(null);
      } else if (windowHandle.current?.locateRecord(locating.key, locating.at)) {
        // The record is in a folded turn whose records load on demand; the
        // fold reports back through onLocated once they are in.
      } else if (props.historyCursor && props.onLoadOlder) {
        if (!props.loadingOlder) loadOlder();
      } else {
        setLocating(null);
        props.onError("没有在已加载的会话中找到这条记录");
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locating, searching, props.loading, props.loadingOlder, props.historyCursor, items, mountedForLocate]);
  const navigationMessages = useMemo(
    () => items.flatMap((item) => item.kind === "message" ? [item.message] : []),
    [items],
  );

  return (
    <div className="conversation-view" data-testid="conversation-view">
      <div className="conversation-context" data-testid="conversation-context">
        {props.title && (
          <div className="conversation-title" title={props.title}>
            <strong>{props.title}</strong>
          </div>
        )}
        {props.agents && props.onOpenAgentPanel && (
          <AgentStatusIndicator
            agents={props.agents}
            onOpen={props.onOpenAgentPanel}
          />
        )}
        <TimelineToolbar
          key={props.sessionId}
          sessionId={props.sessionId}
          filter={filter}
          query={query}
          exporting={exporting}
          onFilter={setFilter}
          onQuery={setQuery}
          onShare={props.client && props.sessionId ? () => setShowShare(true) : undefined}
          onDiagnostics={props.client && props.sessionId ? () => setShowDiagnostics(true) : undefined}
          onExport={(format) => void exportSession(format)}
          summary={props.summary}
          onStep={searching ? navigation.step : undefined}
          navigator={searching && !historySearch.error ? (
            <SessionSearchNavigator
              count={navigation.count}
              position={navigation.position}
              more={hasOlder}
              loading={Boolean(loadingOlder) || navigation.loadingMore}
              onStep={navigation.step}
              onLocate={locate}
            />
          ) : null}
        />
      </div>
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
        <TimelineQuote scrollRef={scrollRef} />
        <div className="timeline" ref={scrollRef} tabIndex={0} onScroll={onScroll}>
          <div ref={historyTopRef} className="history-top-sentinel" aria-hidden="true" />
        {(props.loading || (historySearch.loading && !historySearch.page)) && (
          <div className="history-loading" role="status">
            <Spinner size={16} />
            正在加载会话
          </div>
        )}
        {locating && (
          <div className="history-loading" role="status">
            <Spinner size={16} />
            正在定位记录
          </div>
        )}
        {historySearch.error && !historySearch.page && (
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
        {(loadingOlder || retryingOlder) && !(historySearch.loading && !historySearch.page) && (
          <div className="history-loading" role="status">
            <Spinner size={14} />
            正在加载更早的记录
          </div>
        )}
        {historyError && !retryingOlder && (
          <div className="history-loading" role="alert">
            {historyError}
            <button
              type="button"
              className="icon-button"
              title="重试加载历史记录"
              aria-label="重试加载历史记录"
              disabled={Boolean(loadingOlder) || retryingOlder}
              onClick={loadOlder}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        )}
        {searching && hasOlder && (
          <div className="history-pages">
            <button
              type="button"
              className="ghost"
              disabled={Boolean(loadingOlder) || retryingOlder}
              onClick={loadOlder}
            >
              {loadingOlder ? (
                <Spinner size={14} />
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
          goal={props.goal}
          expandGroups={filter !== "all" || !!query}
          onError={props.onError}
          questions={props.questions}
          turnPlans={props.turnPlans}
          streamingText={props.streamingText}
          latestTurnTiming={props.latestTurnTiming}
          status={!props.loading && props.approvals.length === 0 && <ExecutionStatusBar
            key={props.sessionId} messages={props.messages} calls={props.toolCalls}
            progress={props.turnProgress} plan={props.plan} busy={props.busy}
            approvals={0} questions={props.questions.length} timing={props.latestTurnTiming}
          />}
          showActivity={props.busy && !props.loading && props.approvals.length === 0 && props.questions.length === 0}
          progress={props.turnProgress}
          busy={props.busy}
          onResolveQuestion={props.onResolveQuestion}
          onRollback={props.onRollback}
          onOpenFile={props.onOpenFile}
          onOpenUrl={props.onOpenUrl}
          onRewrite={props.onRewrite}
          onFork={props.onFork}
          onStopTurn={props.onStopTurn}
          workspacePath={props.workspacePath}
          workspacePaths={props.workspacePaths}
          scrollRef={scrollRef}
          windowHandle={windowHandle}
          onLocated={onLocated}
        />
          <QueueBar
            queue={props.queue}
            onSteer={props.onSteerQueued}
            onRemove={props.onRemoveQueued}
            onUpdate={props.onUpdateQueued}
            onMove={props.onMoveQueued}
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
      </div>
      <PendingApprovalBar approvals={props.approvals} onResolve={props.onResolveApproval} />

    </div>
  );
}
