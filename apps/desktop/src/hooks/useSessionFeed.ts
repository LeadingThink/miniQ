import { useCallback, useEffect, useReducer, useRef } from "react";
import type { RpcClient } from "../rpc";
import type {
  Approval,
  Artifact,
  DaemonEvent,
  Message,
  PlanTask,
  Question,
  QueuedMessage,
  SessionStatus,
  ToolCall,
  TurnProgress,
  HistoryPage,
  HistoryCursor,
  EventCursor,
} from "../types";

export interface PendingApproval {
  approval: Approval;
  toolName: string;
  input: unknown;
}

interface SessionFeedState {
  eventCursor: EventCursor | null;
  buffered: { event: DaemonEvent; receivedAt: string }[];
  loading: boolean;
  syncing: boolean;
  nextCursor: HistoryCursor | null;
  messages: Message[];
  toolCalls: ToolCall[];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  artifacts: Artifact[];
  queue: QueuedMessage[];
  streamingText: string;
  turnProgress: TurnProgress | null;
}

export interface LoadedSessionFeed {
  eventCursor?: EventCursor | null;
  nextCursor?: HistoryCursor | null;
  messages: Message[];
  toolCalls: ToolCall[];
  artifacts: Artifact[];
  plan: PlanTask[];
  queue: QueuedMessage[];
  approvals: PendingApproval[];
  questions: Question[];
  streamingText: string;
  turnProgress: TurnProgress | null;
}

type SessionFeedAction =
  | { kind: "reset" }
  | { kind: "load_failed" }
  | { kind: "begin_sync" }
  | { kind: "prepend"; page: HistoryPage }
  | { kind: "replay"; events: DaemonEvent[]; cursor: EventCursor }
  | { kind: "load"; feed: LoadedSessionFeed }
  | { kind: "daemon"; event: DaemonEvent; receivedAt: string };

interface ScopedFeed {
  sessionId: string | null;
  feed: SessionFeedState;
}

const EMPTY_FEED: SessionFeedState = {
  eventCursor: null,
  buffered: [],
  loading: false,
  syncing: false,
  nextCursor: null,
  messages: [],
  toolCalls: [],
  approvals: [],
  questions: [],
  plan: [],
  artifacts: [],
  queue: [],
  streamingText: "",
  turnProgress: null,
};

function updateFinishedToolCall(
  toolCalls: ToolCall[],
  event: Extract<DaemonEvent, { type: "tool_call_finished" }>,
  receivedAt: string,
): ToolCall[] {
  if (!toolCalls.some((toolCall) => toolCall.id === event.toolCallId)) {
    return toolCalls;
  }
  return toolCalls.map((toolCall) =>
    toolCall.id === event.toolCallId
      ? { ...toolCall, status: event.status, output: event.output, payloadDeferred: event.payloadDeferred, completedAt: receivedAt }
      : toolCall,
  );
}

function reduceDaemonEvent(
  state: SessionFeedState,
  event: DaemonEvent,
  receivedAt: string,
): SessionFeedState {
  switch (event.type) {
    case "message_created":
      return {
        ...state,
        messages: state.messages.some((message) => message.id === event.message.id)
          ? state.messages
          : [...state.messages, event.message],
        streamingText:
          event.message.role === "assistant" ? "" : state.streamingText,
        plan: event.message.role === "user" ? [] : state.plan,
        turnProgress: event.message.role === "user" ? null : state.turnProgress,
      };
    case "turn_progress_changed":
      return { ...state, turnProgress: event.progress };
    case "assistant_delta":
      return { ...state, streamingText: state.streamingText + event.delta };
    case "assistant_replaced":
      return { ...state, streamingText: event.text };
    case "tool_call_started":
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls.filter((toolCall) => toolCall.id !== event.toolCallId),
          {
            id: event.toolCallId,
            sessionId: event.sessionId,
            toolName: event.toolName,
            input: event.input,
            payloadDeferred: event.payloadDeferred,
            live: true,
            status: "running",
            createdAt: receivedAt,
          },
        ],
      };
    case "tool_call_finished":
      return {
        ...state,
        toolCalls: updateFinishedToolCall(state.toolCalls, event, receivedAt),
        approvals: state.approvals.filter(
          (item) => item.approval.toolCallId !== event.toolCallId,
        ),
      };
    case "approval_requested":
      return state.approvals.some((item) => item.approval.id === event.approval.id)
        ? state
        : {
            ...state,
            approvals: [
              ...state.approvals,
              { approval: event.approval, toolName: event.toolName, input: event.input },
            ],
          };
    case "approval_resolved":
      return {
        ...state,
        approvals: state.approvals.filter(
          (item) => item.approval.id !== event.approval.id,
        ),
      };
    case "plan_updated":
      return { ...state, plan: event.tasks };
    case "question_requested":
      return state.questions.some((question) => question.id === event.question.id)
        ? state
        : { ...state, questions: [...state.questions, event.question] };
    case "question_resolved":
      return {
        ...state,
        questions: state.questions.filter((question) => question.id !== event.questionId),
      };
    case "artifact_created":
      return state.artifacts.some((artifact) => artifact.id === event.artifact.id)
        ? state
        : { ...state, artifacts: [...state.artifacts, event.artifact] };
    case "turn_completed":
    case "turn_failed":
      return { ...state, streamingText: "", turnProgress: null };
    case "queue_changed":
      return { ...state, queue: event.queue };
    case "session_status_changed":
    case "model_settings_changed":
    case "context_compacted":
    case "session_deleted":
    case "workspace_deleted":
    case "session_renamed":
    case "workspace_renamed":
    case "workspace_updated":
    case "plugins_changed":
    case "session_pinned_changed":
    case "session_archived_changed":
      return state;
    default:
      return state;
  }
}

function sessionFeedReducer(
  state: SessionFeedState,
  action: SessionFeedAction,
): SessionFeedState {
  if (action.kind === "reset") return { ...EMPTY_FEED, loading: true };
  if (action.kind === "load_failed") return { ...state, loading: false, syncing: false, eventCursor: null, buffered: [] };
  if (action.kind === "begin_sync") return { ...state, syncing: true };
  if (action.kind === "prepend") return {
    ...state,
    messages: mergeHistory(action.page.messages, state.messages),
    toolCalls: mergeHistory(action.page.toolCalls, state.toolCalls),
    nextCursor: action.page.nextCursor,
  };
  if (action.kind === "load") {
    let loaded: SessionFeedState = {
      ...EMPTY_FEED,
      eventCursor: action.feed.eventCursor ?? null,
      nextCursor: action.feed.nextCursor ?? null,
      messages: action.feed.messages,
      toolCalls: action.feed.toolCalls,
      artifacts: action.feed.artifacts,
      plan: action.feed.plan,
      queue: action.feed.queue,
      approvals: action.feed.approvals,
      questions: action.feed.questions,
      streamingText: action.feed.streamingText,
      turnProgress: action.feed.turnProgress,
    };
    for (const item of state.buffered) loaded = applySequencedEvent(loaded, item.event, item.receivedAt);
    return loaded;
  }
  if (action.kind === "replay") {
    let loaded: SessionFeedState = { ...state, syncing: false, buffered: [] };
    const pending = [...action.events.map((event) => ({event, receivedAt: new Date().toISOString()})), ...state.buffered]
      .sort((a, b) => (a.event.eventCursor?.sequence ?? 0) - (b.event.eventCursor?.sequence ?? 0));
    for (const {event, receivedAt} of pending) loaded = applySequencedEvent(loaded, event, receivedAt);
    const cursor = loaded.eventCursor;
    return { ...loaded, eventCursor: cursor?.epoch === action.cursor.epoch && cursor.sequence > action.cursor.sequence ? cursor : action.cursor };
  }
  if (state.loading || state.syncing) return { ...state, buffered: [...state.buffered, { event: action.event, receivedAt: action.receivedAt }] };
  return applySequencedEvent(state, action.event, action.receivedAt);
}

function applySequencedEvent(state: SessionFeedState, event: DaemonEvent, receivedAt: string): SessionFeedState {
  const cursor = event.eventCursor;
  if (cursor && state.eventCursor?.epoch === cursor.epoch && cursor.sequence <= state.eventCursor.sequence) return state;
  return { ...reduceDaemonEvent(state, event, receivedAt), eventCursor: cursor ?? state.eventCursor };
}

interface SessionFeedOptions {
  client: RpcClient;
  currentSessionId: string | null;
  refreshSessions: () => Promise<void>;
  onSessionStatusChanged: (sessionId: string, status: SessionStatus) => void;
  onSessionCompleted: (sessionId: string) => void;
  onError: (sessionId: string, message: string | null) => void;
}

export function useSessionFeed(options: SessionFeedOptions) {
  const [state, dispatch] = useReducer(
    (state: ScopedFeed, action: SessionFeedAction & { sessionId: string | null }): ScopedFeed => ({
      sessionId: action.sessionId,
      feed: sessionFeedReducer(state.sessionId === action.sessionId ? state.feed : EMPTY_FEED, action),
    }),
    { sessionId: null, feed: EMPTY_FEED },
  );
  const {
    client,
    currentSessionId,
    refreshSessions,
    onSessionStatusChanged,
    onSessionCompleted,
    onError,
  } = options;
  const activeSession = useRef(currentSessionId);
  activeSession.current = currentSessionId;

  useEffect(() => {
    const pause = () => dispatch({ kind: "begin_sync", sessionId: activeSession.current });
    const offStatus = client.onStatus((connected) => { if (!connected) pause(); });
    const offResync = client.onResync(pause);
    return () => { offStatus(); offResync(); };
  }, [client]);

  useEffect(() => {
    return client.onEvent((event) => {
      if (activeSession.current !== currentSessionId) return;
      if (event.type === "turn_failed") onError(event.sessionId, event.error);
      if (event.type === "message_created" && event.message.role === "user") onError(event.sessionId, null);
      // Workspace-level events have no session context.
      if (
        event.type === "workspace_deleted" ||
        event.type === "workspace_renamed" ||
        event.type === "workspace_updated" ||
        event.type === "plugins_changed"
      ) {
        if (event.type === "plugins_changed") return;
        void refreshSessions();
        return;
      }
      // Session metadata changes that affect the sidebar list.
      if (
        event.type === "session_deleted" ||
        event.type === "session_renamed" ||
        event.type === "session_pinned_changed" ||
        event.type === "session_archived_changed"
      ) {
        void refreshSessions();
        if (event.sessionId !== currentSessionId) return;
        if (event.type === "session_deleted") return;
      }
      // Events for other sessions: only refresh sidebar on status change.
      if (event.sessionId !== currentSessionId) {
        if (event.type === "session_status_changed") {
          onSessionStatusChanged(event.sessionId, event.status);
          void refreshSessions();
        } else if (event.type === "turn_completed" || event.type === "turn_failed") {
          onSessionCompleted(event.sessionId);
        }
        return;
      }
      if (event.type === "session_status_changed") {
        onSessionStatusChanged(event.sessionId, event.status);
      }
      dispatch({
        kind: "daemon",
        sessionId: currentSessionId,
        event,
        receivedAt: new Date().toISOString(),
      });
    });
  }, [client, currentSessionId, onError, onSessionCompleted, onSessionStatusChanged, refreshSessions]);

  const reset = useCallback((sessionId: string | null = activeSession.current) => {
    activeSession.current = sessionId;
    dispatch({ kind: "reset", sessionId });
  }, []);
  const load = useCallback(
    (sessionId: string, feed: LoadedSessionFeed) => {
      if (sessionId === activeSession.current) dispatch({ kind: "load", sessionId, feed });
    },
    [],
  );

  const prepend = useCallback((sessionId: string, page: HistoryPage) => {
    if (sessionId === activeSession.current) dispatch({ kind: "prepend", sessionId, page });
  }, []);
  const failLoad = useCallback((sessionId: string) => {
    if (sessionId === activeSession.current) dispatch({ kind: "load_failed", sessionId });
  }, []);
  const applyReplay = useCallback((sessionId: string, events: DaemonEvent[], cursor: EventCursor) => {
    if (sessionId === activeSession.current) dispatch({ kind: "replay", sessionId, events, cursor });
  }, []);

  return { ...(state.sessionId === currentSessionId ? state.feed : EMPTY_FEED), reset, load, prepend, failLoad, applyReplay };
}

function mergeHistory<T extends { id: string }>(older: T[], current: T[]): T[] {
  const records = new Map(older.map((record) => [record.id, record]));
  for (const record of current) records.set(record.id, record);
  return [...records.values()];
}
