// Protocol types mirroring crates/miniq-protocol. Keep in sync until the
// JSON Schema -> TS generation pipeline lands.

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "failed";

export type Role = "user" | "assistant" | "system" | "tool";

export type ToolCallStatus =
  | "pending"
  | "waiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "approved_for_session"
  | "rejected";

export interface Workspace {
  id: string;
  path: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: ToolCallStatus;
  createdAt: string;
  completedAt?: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  toolCallId: string;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  reason: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface PlanTask {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface Question {
  id: string;
  sessionId: string;
  toolCallId: string;
  prompt: string;
  options: string[];
}

export interface Artifact {
  id: string;
  sessionId: string;
  path: string;
  kind: string;
  title: string;
  createdAt: string;
}

export interface HealthStatus {
  protocolVersion: number;
  daemonVersion: string;
  uptimeSecs: number;
}

/** How risky tool calls are gated (mirrors daemon ApprovalMode). */
export type ApprovalMode = "alwaysAsk" | "auto" | "fullAccess";

/** Schedule spec for a recurring task. */
export type ScheduleSpec =
  | { type: "daily"; time: string }
  | { type: "weekly"; weekday: number; time: string }
  | { type: "interval"; minutes: number };

export interface ScheduledTask {
  id: string;
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastSessionId: string | null;
  createdAt: string;
}

export type DaemonEvent =
  | { type: "session_status_changed"; sessionId: string; status: SessionStatus }
  | { type: "message_created"; sessionId: string; message: Message }
  | { type: "assistant_delta"; sessionId: string; messageId: string; delta: string }
  | {
      type: "tool_call_started";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_call_finished";
      sessionId: string;
      toolCallId: string;
      status: ToolCallStatus;
      output?: unknown;
    }
  | {
      type: "approval_requested";
      sessionId: string;
      approval: Approval;
      toolName: string;
      input: unknown;
      riskLevel: RiskLevel;
    }
  | { type: "approval_resolved"; sessionId: string; approval: Approval }
  | { type: "plan_updated"; sessionId: string; tasks: PlanTask[] }
  | { type: "question_requested"; sessionId: string; question: Question }
  | { type: "question_resolved"; sessionId: string; questionId: string; answer: string }
  | { type: "artifact_created"; sessionId: string; artifact: Artifact }
  | { type: "turn_completed"; sessionId: string }
  | { type: "turn_failed"; sessionId: string; error: string };
