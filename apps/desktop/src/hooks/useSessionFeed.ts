import { useCallback, useEffect, useReducer } from "react";
import type { RpcClient } from "../rpc";
import type {
  Approval,
  Artifact,
  DaemonEvent,
  Message,
  PlanTask,
  Question,
  SessionStatus,
  ToolCall,
} from "../types";

export interface PendingApproval {
  approval: Approval;
  toolName: string;
  input: unknown;
}

interface SessionFeedState {
  messages: Message[];
  toolCalls: ToolCall[];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  artifacts: Artifact[];
  streamingText: string;
}

export interface LoadedSessionFeed {
  messages: Message[];
  toolCalls: ToolCall[];
  artifacts: Artifact[];
  plan: PlanTask[];
}

type SessionFeedAction =
  | { kind: "reset" }
  | { kind: "load"; feed: LoadedSessionFeed }
  | { kind: "daemon"; event: DaemonEvent; receivedAt: string };

const EMPTY_FEED: SessionFeedState = {
  messages: [],
  toolCalls: [],
  approvals: [],
  questions: [],
  plan: [],
  artifacts: [],
  streamingText: "",
};

function updateFinishedToolCall(
  toolCalls: ToolCall[],
  event: Extract<DaemonEvent, { type: "tool_call_finished" }>,
): ToolCall[] {
  if (!toolCalls.some((toolCall) => toolCall.id === event.toolCallId)) {
    return toolCalls;
  }
  return toolCalls.map((toolCall) =>
    toolCall.id === event.toolCallId
      ? { ...toolCall, status: event.status, output: event.output }
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
      };
    case "assistant_delta":
      return { ...state, streamingText: state.streamingText + event.delta };
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
            status: "running",
            createdAt: receivedAt,
          },
        ],
      };
    case "tool_call_finished":
      return {
        ...state,
        toolCalls: updateFinishedToolCall(state.toolCalls, event),
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
      return { ...state, streamingText: "" };
    case "session_status_changed":
    case "context_compacted":
    case "session_deleted":
    case "workspace_deleted":
    case "session_renamed":
    case "workspace_renamed":
    case "session_pinned_changed":
      return state;
  }
}

function sessionFeedReducer(
  state: SessionFeedState,
  action: SessionFeedAction,
): SessionFeedState {
  if (action.kind === "reset") return EMPTY_FEED;
  if (action.kind === "load") {
    return {
      ...EMPTY_FEED,
      messages: action.feed.messages,
      toolCalls: action.feed.toolCalls,
      artifacts: action.feed.artifacts,
      plan: action.feed.plan,
    };
  }
  return reduceDaemonEvent(state, action.event, action.receivedAt);
}

interface SessionFeedOptions {
  client: RpcClient;
  currentSessionId: string | null;
  refreshSessions: () => Promise<void>;
  onSessionStatusChanged: (sessionId: string, status: SessionStatus) => void;
  onError: (message: string) => void;
}

export function useSessionFeed(options: SessionFeedOptions) {
  const [state, dispatch] = useReducer(sessionFeedReducer, EMPTY_FEED);
  const {
    client,
    currentSessionId,
    refreshSessions,
    onSessionStatusChanged,
    onError,
  } = options;

  useEffect(() => {
    return client.onEvent((event) => {
      // Workspace-level events have no session context.
      if (event.type === "workspace_deleted" || event.type === "workspace_renamed") {
        void refreshSessions();
        return;
      }
      // Session metadata changes that affect the sidebar list.
      if (
        event.type === "session_deleted" ||
        event.type === "session_renamed" ||
        event.type === "session_pinned_changed"
      ) {
        void refreshSessions();
        if (event.sessionId !== currentSessionId) return;
        if (event.type === "session_deleted") return;
      }
      // Events for other sessions: only refresh sidebar on status change.
      if (event.sessionId !== currentSessionId) {
        if (event.type === "session_status_changed") {
          void refreshSessions();
        }
        return;
      }
      if (event.type === "session_status_changed") {
        onSessionStatusChanged(event.sessionId, event.status);
      }
      if (event.type === "turn_failed") onError(event.error);
      dispatch({
        kind: "daemon",
        event,
        receivedAt: new Date().toISOString(),
      });
    });
  }, [client, currentSessionId, onError, onSessionStatusChanged, refreshSessions]);

  const reset = useCallback(() => dispatch({ kind: "reset" }), []);
  const load = useCallback(
    (feed: LoadedSessionFeed) => dispatch({ kind: "load", feed }),
    [],
  );

  return { ...state, reset, load };
}
