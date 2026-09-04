// Protocol types mirroring crates/miniq-protocol. Keep in sync until the
// JSON Schema -> TS generation pipeline lands.

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "failed";

export type TurnPhase =
  | "preparing_context"
  | "compacting_context"
  | "requesting_model"
  | "receiving_model"
  | "finalizing";

export interface TurnProgress {
  phase: TurnPhase;
  modelStep?: number;
  startedAt: string;
}

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
  pinned: boolean;
  archived: boolean;
  external?: ExternalSessionLink;
  createdAt: string;
  updatedAt: string;
}

/** A user message queued while the session had an active turn. */
export interface QueuedMessage {
  id: string;
  sessionId: string;
  content: string;
  position: number;
  createdAt: string;
}

export type ExternalProvider = "codex" | "claude_code" | "opencode";

export type ExternalContinuationMode =
  | "native_resumable"
  | "recreate_only"
  | "read_only";

export interface ExternalSessionLink {
  provider: ExternalProvider;
  externalId: string;
  sourcePath: string;
  continuationMode: ExternalContinuationMode;
  importedAt: string;
  lastSyncedAt: string;
}

export interface ExternalSessionSummary {
  provider: ExternalProvider;
  externalId: string;
  title: string;
  cwd: string | null;
  sourcePath: string;
  messageCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  continuationMode: ExternalContinuationMode;
}

export interface ExternalProviderStatus {
  provider: ExternalProvider;
  root: string;
  available: boolean;
  sessionCount: number;
  messageCount: number;
  error: string | null;
}

export interface ExternalScanError {
  provider: ExternalProvider;
  sourcePath: string | null;
  message: string;
}

export interface ExternalSessionScan {
  providers: ExternalProviderStatus[];
  sessions: ExternalSessionSummary[];
  errors: ExternalScanError[];
}

export interface ExternalSessionSelection {
  provider: ExternalProvider;
  externalId: string;
  sourcePath: string;
  workspaceId: string | null;
}

export interface ExternalImportError {
  provider: ExternalProvider;
  externalId: string | null;
  message: string;
}

export interface ExternalSessionImportResult {
  importedSessionIds: string[];
  importedMessages: number;
  errors: ExternalImportError[];
}

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  attachments?: MessageAttachment[];
  createdAt: string;
}

export interface MessageAttachment {
  path: string;
  name: string;
  mimeType?: string;
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
  createdAt: string;
  autoContinueAfterSeconds?: number;
  defaultAnswer?: string;
}

export interface Artifact {
  id: string;
  sessionId: string;
  path: string;
  kind: string;
  title: string;
  createdAt: string;
}

export type DiffLineKind = "context" | "addition" | "deletion";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  absolutePath: string;
  oldExists: boolean;
  newExists: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface SessionDiff {
  files: FileDiff[];
  additions: number;
  deletions: number;
}

export interface HealthStatus {
  protocolVersion: number;
  daemonVersion: string;
  uptimeSecs: number;
}

export type PluginStatus = "discovered" | "disabled" | "loading" | "active" | "failed" | "unloading";
export type PluginRuntime = "wasm" | "node";
export type PluginProcessState = "not_applicable" | "stopped" | "starting" | "running" | "failed";
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  status: PluginStatus;
  tools: string[];
  error: string | null;
  description: string | null;
  author: string | null;
  runtime: PluginRuntime;
  capabilities: string[];
  permissions: string[];
  trustedCode: boolean;
  processState: PluginProcessState;
  entry: string;
  engineNode: string | null;
  trustConfirmed: boolean;
}
export interface PluginListResult {
  plugins: PluginInfo[];
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
  | { type: "turn_progress_changed"; sessionId: string; progress: TurnProgress }
  | { type: "message_created"; sessionId: string; message: Message }
  | { type: "assistant_delta"; sessionId: string; messageId: string; delta: string }
  | {
      type: "context_compacted";
      sessionId: string;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
    }
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
  | { type: "turn_failed"; sessionId: string; error: string }
  | { type: "session_deleted"; sessionId: string }
  | { type: "workspace_deleted"; workspaceId: string }
  | { type: "session_renamed"; sessionId: string; title: string }
  | { type: "workspace_renamed"; workspaceId: string; name: string }
  | { type: "session_pinned_changed"; sessionId: string; pinned: boolean }
  | { type: "session_archived_changed"; sessionId: string; archived: boolean }
  | { type: "queue_changed"; sessionId: string; queue: QueuedMessage[] }
  | { type: "plugins_changed"; plugins: PluginInfo[] };
