import { expect, it } from "vitest";
import type { TimelineGroup } from "./timelineModel";
import type { ToolCall, TurnTiming } from "./types";
import { groupTimelineTurns, searchRecordKeys, turnSeparators } from "./timelineTurns";

const timing: TurnTiming = { startedAt: "2026-09-20T10:00:00Z", completedAt: "2026-09-20T10:01:00Z", elapsedMs: 60_000, status: "completed" };
const message = (id: string, role: "user" | "assistant", at: string, turnTiming?: TurnTiming): TimelineGroup => ({
  kind: "message", at, message: { id, role, sessionId: "s", content: id, createdAt: at, turnTiming },
});
const tools = (at: string, ...ids: string[]): TimelineGroup => ({
  kind: "tools", at, calls: ids.map((id): ToolCall => ({ id, sessionId: "s", toolName: "shell_exec", input: {}, status: "succeeded", createdAt: at })),
});

it("attaches each turn's recorded timing, preferring the latest live update", () => {
  const stopped: TurnTiming = { ...timing, status: "cancelled", elapsedMs: 5000 };
  const turns = groupTimelineTurns([
    message("u1", "user", timing.startedAt, { ...timing, status: "running" }),
    message("a1", "assistant", timing.completedAt!),
    message("u2", "user", "2026-09-20T10:05:00Z", stopped),
  ], { messageId: "u1", timing });
  expect(turns.map((turn) => [turn.key, turn.timing])).toEqual([["message:u1", timing], ["message:u2", stopped]]);
});

it("gives a page that begins mid-turn the latest timing only when it belongs to it", () => {
  const latest = { messageId: "u1", timing };
  expect(groupTimelineTurns([message("a1", "assistant", timing.completedAt!)], latest)[0].timing).toBe(timing);
  expect(groupTimelineTurns([message("older", "assistant", "2026-09-19T10:00:00Z")], latest)[0].timing).toBeUndefined();
});

it("lists every record a set of groups shows, including grouped tool calls", () => {
  expect(searchRecordKeys([message("u1", "user", timing.startedAt), tools(timing.startedAt, "t1", "t2")]))
    .toBe("message:u1 tool:t1 tool:t2");
});

it("separates turns after long breaks and new days, never inside a turn", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const turns = groupTimelineTurns([
    message("u1", "user", "2026-09-19T10:00:00Z"),
    message("a1", "assistant", "2026-09-19T11:00:00Z"),
    message("u2", "user", "2026-09-19T11:20:00Z"),
    message("a2", "assistant", "2026-09-19T11:25:00Z"),
    message("u3", "user", "2026-09-19T11:55:00Z"),
  ]);
  const separators = turnSeparators(turns, now);
  // A one-hour reply gap inside turn u1 is not a turn boundary.
  expect([...separators.keys()]).toEqual(["message:u1", "message:u3"]);
  expect(separators.get("message:u3")).toBe("2026-09-19T11:55:00Z");
  // A page that starts mid-turn has no turn start to mark.
  expect(turnSeparators(groupTimelineTurns([message("a0", "assistant", "2026-09-01T00:00:00Z")]), now).size).toBe(0);
});
