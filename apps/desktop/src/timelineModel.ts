import type { Message, ToolCall } from "./types";

export type TimelineItem =
  | { kind: "message"; at: string; message: Message }
  | { kind: "tool"; at: string; call: ToolCall };
export type TimelineGroup =
  | Extract<TimelineItem, { kind: "message" }>
  | { kind: "tools"; at: string; calls: ToolCall[] };
export type TimelineFilter = "all" | "answers" | "activity" | "errors";

export function createTimelineItems(
  messages: Message[],
  toolCalls: ToolCall[],
  includeInternal = false
): TimelineItem[] {
  return [
    ...messages
      .filter((message) => includeInternal || message.role !== "system")
      .map((message) => ({
        kind: "message" as const,
        at: message.createdAt,
        message,
      })),
    ...toolCalls
      .filter((call) => includeInternal || call.toolName !== "task_update")
      .map((call) => ({ kind: "tool" as const, at: call.createdAt, call })),
  ].sort((a, b) => {
    const difference = Date.parse(a.at) - Date.parse(b.at);
    return Number.isFinite(difference) ? difference : a.at.localeCompare(b.at);
  });
}

export function payloadText(value: unknown): string {
  return typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2) ?? "";
}

export function itemMatches(
  item: TimelineItem,
  filter: TimelineFilter,
  query: string
): boolean {
  if (
    filter === "answers" &&
    (item.kind !== "message" || item.message.role === "tool")
  )
    return false;
  if (
    filter === "activity" &&
    item.kind !== "tool" &&
    item.message.role !== "tool"
  )
    return false;
  if (
    filter === "errors" &&
    (item.kind !== "tool" ||
      !["failed", "rejected", "cancelled"].includes(item.call.status))
  )
    return false;
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const text =
    item.kind === "message"
      ? item.message.content
      : `${item.call.toolName}\n${payloadText(item.call.input)}\n${payloadText(
          item.call.output
        )}`;
  return text.toLocaleLowerCase().includes(needle);
}

export function groupTimeline(items: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    if (item.kind === "tool" && previous?.kind === "tools")
      previous.calls.push(item.call);
    else if (item.kind === "tool")
      groups.push({ kind: "tools", at: item.at, calls: [item.call] });
    else groups.push(item);
  }
  return groups;
}

export function filterTimelineGroups(
  groups: TimelineGroup[],
  filter: TimelineFilter,
  query: string
): TimelineGroup[] {
  return groups.flatMap((group): TimelineGroup[] => {
    if (group.kind !== "tools")
      return itemMatches(group, filter, query) ? [group] : [];
    const calls = group.calls.filter((call) =>
      itemMatches({ kind: "tool", at: call.createdAt, call }, filter, query)
    );
    return calls.length ? [{ ...group, calls }] : [];
  });
}

export function toolCounts(calls: ToolCall[]) {
  return {
    completed: calls.filter((call) => call.status === "succeeded").length,
    running: calls.filter((call) =>
      ["running", "pending", "waiting_approval"].includes(call.status)
    ).length,
    failed: calls.filter((call) =>
      ["failed", "rejected", "cancelled"].includes(call.status)
    ).length,
    attention: calls.some(
      (call) => call.status === "failed" || call.status === "waiting_approval"
    ),
  };
}

export function payloadPage(
  text: string,
  query: string,
  page: number,
  pageSize = 100
) {
  const needle = query.toLocaleLowerCase();
  const lines = text
    .split("\n")
    .map((text, index) => ({ text, number: index + 1 }));
  const matches = needle
    ? lines.filter((line) => line.text.toLocaleLowerCase().includes(needle))
    : lines;
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  return {
    lines: matches.slice(current * pageSize, (current + 1) * pageSize),
    page: current,
    pageCount,
    total: matches.length,
  };
}
