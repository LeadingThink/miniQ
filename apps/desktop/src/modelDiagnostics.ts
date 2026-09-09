import type { ApiProtocol, ReasoningEffort } from "./modelSelection";
import type { HistoryCursor, TurnProgress } from "./types";

export type ExecutionEventRecord = {
  id: string;
  sessionId: string;
  createdAt: string;
} & (
  | {
      type: "model_retry";
      data: { agentId: string | null; progress: TurnProgress };
    }
  | {
      type: "context_compacted";
      data: {
        agentId: string | null;
        turnId: string;
        estimatedTokensBefore: number;
        estimatedTokensAfter: number;
      };
    }
  | {
      type: "queued_message_started";
      data: {
        sourceMessageId: string;
        queuedMessageId: string;
        queuedAt: string;
      };
    }
  | { type: "turn_outcome"; data: { anchorMessageId: string; status: string } }
);

export interface ExecutionEventsPage {
  events: ExecutionEventRecord[];
  nextCursor: HistoryCursor | null;
}

export interface ModelCallRecord {
  id: string;
  sessionId: string;
  agentId: string | null;
  turnId: string;
  sourceMessageId: string | null;
  trace: {
    purpose: "task" | "compaction" | "planReview" | "skillLearning";
    step: number | null;
    attempt: number;
  };
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  status: "running" | "completed" | "failed" | "interrupted";
  request: {
    model: string;
    apiProtocol: ApiProtocol;
    reasoningEffort: ReasoningEffort | null;
    maxOutputTokens: number | null;
  } | null;
  estimatedInputTokens: number;
  advertisedContextTokens: number | null;
  advertisedOutputTokens: number | null;
  response: {
    model: string | null;
    responseId: string | null;
    usage: Record<string, unknown> | null;
    stopReason: string | null;
  };
  error: string | null;
}

export interface ModelCallsPage {
  calls: ModelCallRecord[];
  nextCursor: HistoryCursor | null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function reportedTokens(record: ModelCallRecord) {
  const usage = record.response.usage;
  const details =
    usage?.output_tokens_details ?? usage?.completion_tokens_details;
  const reasoning =
    details && typeof details === "object"
      ? (details as Record<string, unknown>).reasoning_tokens
      : null;
  return {
    input: count(usage?.input_tokens ?? usage?.prompt_tokens),
    output: count(usage?.output_tokens ?? usage?.completion_tokens),
    reasoning: count(reasoning),
  };
}
