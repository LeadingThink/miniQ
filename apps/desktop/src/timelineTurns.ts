import type { AnchoredTurnTiming, ToolCall, TurnSummary, TurnTiming } from "./types";
import type { TimelineGroup } from "./timelineModel";
import { timelineGroupKey } from "./timelineTiming";
import { showTurnSeparator } from "./time";

/** A user message plus everything that followed it until the next user message.
 * The first turn of a partially loaded page may have no user message. */
export interface TimelineTurn {
  key: string;
  userMessageId?: string;
  groups: TimelineGroup[];
  timing?: TurnTiming;
}

/** A user message that opens a turn. A steered message continues the turn it
 * interrupted, so it stays inline in that turn's process. */
const isUser = (group: TimelineGroup) =>
  group.kind === "message" && group.message.role === "user" && !group.message.steered;

export function groupTimelineTurns(groups: TimelineGroup[], latest?: AnchoredTurnTiming | null): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  for (const group of groups) {
    const current = turns.at(-1);
    if (!current || isUser(group)) {
      const userMessageId = isUser(group) && group.kind === "message" ? group.message.id : undefined;
      const timing = group.kind === "message" && userMessageId
        ? (userMessageId === latest?.messageId ? latest.timing : group.message.turnTiming)
        : undefined;
      turns.push({ key: timelineGroupKey(group), userMessageId, groups: [group], timing });
    } else {
      current.groups.push(group);
      // The continuation's timing supersedes the interrupted run's.
      if (group.kind === "message" && group.message.steered) {
        const timing = group.message.id === latest?.messageId ? latest.timing : group.message.turnTiming;
        if (timing) current.timing = timing;
      }
    }
  }
  // A page that begins mid-turn still belongs to the latest recorded timing.
  const first = turns[0];
  if (first && !first.userMessageId && latest && turns.length === 1
    && Date.parse(first.groups[0].at) >= Date.parse(latest.timing.startedAt)) first.timing = latest.timing;
  return turns;
}

/** Partition settled output without moving the final answer into the process.
 * Legacy messages lack a phase: only a trailing assistant is treated as final. */
export function completedTurnContent(turn: TimelineTurn): { process: TimelineGroup[]; output: TimelineGroup[] } {
  const body = turn.groups.slice(turn.userMessageId ? 1 : 0);
  let legacyFinal: TimelineGroup | undefined;
  for (const group of body) {
    if (group.kind === "artifact") continue;
    legacyFinal = group.kind === "message" && group.message.role === "assistant"
      && group.message.assistantKind === undefined ? group : undefined;
  }
  const process: TimelineGroup[] = [];
  const output: TimelineGroup[] = [];
  for (const group of body) {
    const visible = group.kind === "artifact" || group === legacyFinal || (group.kind === "message"
      && (group.message.assistantKind === "final" || group.message.assistantKind === "interrupted"));
    (visible ? output : process).push(group);
  }
  return { process, output };
}

/** Segments a running turn keeps in view; older ones fold behind "上 N 条消息". */
export const LIVE_VISIBLE_GROUPS = 4;

/** Split a running turn so only its latest activity stays expanded. */
export function liveTurnContent(turn: TimelineTurn): { earlier: TimelineGroup[]; recent: TimelineGroup[] } {
  const body = turn.groups.slice(turn.userMessageId ? 1 : 0);
  const split = Math.max(0, body.length - LIVE_VISIBLE_GROUPS);
  return { earlier: body.slice(0, split), recent: body.slice(split) };
}

/** Number of individual records in the groups: messages, artifacts and tool calls. */
export function recordCount(groups: TimelineGroup[]): number {
  return groups.reduce((total, group) => total + (group.kind === "tools" ? group.calls.length : 1), 0);
}

/** Search keys of every record the groups show, including each tool call
 * inside a grouped run. Folded and windowed content lists them so search and
 * "查看上下文" can find records that are not rendered individually. */
export function searchRecordKeys(groups: TimelineGroup[]): string {
  return groups.map((group) => group.kind === "tools"
    ? group.calls.map((call) => `tool:${call.id}`).join(" ")
    : timelineGroupKey(group)).join(" ");
}

/** Start time of each turn that follows a break of at least 30 minutes or a
 * new calendar day. A page that begins mid-turn has no turn start to mark. */
export function turnSeparators(turns: TimelineTurn[], now = new Date()): Map<string, string> {
  const separators = new Map<string, string>();
  turns.forEach((turn, index) => {
    if (!turn.userMessageId) return;
    const at = turn.groups[0].at;
    if (showTurnSeparator(at, turns[index - 1]?.groups.at(-1)?.at, now)) separators.set(turn.key, at);
  });
  return separators;
}

const FAILED = new Set(["failed", "rejected"]);
const ACTIVE = new Set(["running", "pending", "waiting_approval"]);

export interface ExecutionSummaryData {
  steps: number;
  failed: number;
  filesChanged?: number;
  durationMs?: number;
  running: boolean;
  waitingApproval: boolean;
  status?: TurnSummary["status"];
}

export function executionSummary(calls: ToolCall[], timing?: TurnTiming): ExecutionSummaryData {
  const summary = timing?.summary;
  const running = timing?.status === "running" || calls.some((call) => ACTIVE.has(call.status));
  const derivedDuration = timing?.elapsedMs ?? (timing?.completedAt
    ? Date.parse(timing.completedAt) - Date.parse(timing.startedAt) : undefined);
  const durationMs = summary?.durationMs ?? derivedDuration;
  return {
    steps: summary?.toolCalls ?? calls.length,
    failed: summary?.failedToolCalls ?? calls.filter((call) => FAILED.has(call.status)).length,
    filesChanged: summary?.filesChanged || undefined,
    durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
    running,
    waitingApproval: calls.some((call) => call.status === "waiting_approval"),
    status: summary?.status ?? (timing && timing.status !== "running" && timing.status !== "interrupted" ? timing.status : undefined),
  };
}

/** Compact duration for a single summary row, e.g. "1分20秒". */
export function compactDuration(ms: number): string {
  if (ms < 1000) return "不足1秒";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}小时${minutes ? `${minutes}分` : ""}`;
  if (minutes) return `${minutes}分${seconds ? `${seconds}秒` : ""}`;
  return `${seconds}秒`;
}
