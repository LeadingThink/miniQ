import type { AnchoredTurnTiming, ToolCall, TurnSummary, TurnTiming } from "./types";
import type { TimelineGroup } from "./timelineModel";
import { timelineGroupKey } from "./timelineTiming";

/** A user message plus everything that followed it until the next user message.
 * The first turn of a partially loaded page may have no user message. */
export interface TimelineTurn {
  key: string;
  userMessageId?: string;
  groups: TimelineGroup[];
  timing?: TurnTiming;
}

export type TurnSegment =
  | { kind: "group"; group: TimelineGroup }
  | { kind: "execution"; key: string; groups: TimelineGroup[]; calls: ToolCall[] };

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

/** Collapse the span from a turn's first to last tool group into one execution
 * segment. Intermediate notes stay inside it; artifacts and the final answer
 * stay visible after it. */
export function turnSegments(turn: TimelineTurn): TurnSegment[] {
  const first = turn.groups.findIndex((group) => group.kind === "tools");
  if (first < 0) return turn.groups.map((group) => ({ kind: "group", group }));
  let last = first;
  turn.groups.forEach((group, index) => { if (group.kind === "tools") last = index; });
  const span = turn.groups.slice(first, last + 1);
  const hidden = span.filter((group) => group.kind !== "artifact" && !isUser(group));
  const lifted = span.filter((group) => group.kind === "artifact");
  return [
    ...turn.groups.slice(0, first).map((group): TurnSegment => ({ kind: "group", group })),
    {
      kind: "execution",
      key: `execution:${timelineGroupKey(span[0])}`,
      groups: hidden,
      calls: hidden.flatMap((group) => group.kind === "tools" ? group.calls : []),
    },
    ...lifted.map((group): TurnSegment => ({ kind: "group", group })),
    ...turn.groups.slice(last + 1).map((group): TurnSegment => ({ kind: "group", group })),
  ];
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
