import { expect, it } from "vitest";
import { timelineTurnEnds } from "./timelineTiming";
import type { TimelineGroup } from "./timelineModel";
import type { TurnTiming } from "./types";

const timing: TurnTiming = { startedAt: "2026-09-20T10:00:00Z", completedAt: "2026-09-20T10:01:00Z", elapsedMs: 60_000, status: "completed" };
const message = (id: string, role: "user" | "assistant", at: string, turnTiming?: TurnTiming): TimelineGroup => ({
  kind: "message", at, message: { id, role, sessionId: "s", content: id, createdAt: at, turnTiming },
});

it("keeps one persisted summary per turn, including cancelled work with no answer", () => {
  const stopped: TurnTiming = { ...timing, status: "cancelled", elapsedMs: 5000 };
  const groups = [
    message("u1", "user", timing.startedAt, timing),
    message("a1", "assistant", timing.completedAt!),
    message("u2", "user", "2026-09-20T10:05:00Z", stopped),
    message("u3", "user", "2026-09-20T10:10:00Z"),
  ];
  expect([...timelineTurnEnds(groups)]).toEqual([["message:a1", timing], ["message:u2", stopped]]);
});

it("does not guess durations for old history or render an active clock as completed", () => {
  expect(timelineTurnEnds([message("old", "user", timing.startedAt), message("old-answer", "assistant", timing.completedAt!)])).toHaveLength(0);
  expect(timelineTurnEnds([message("active", "user", timing.startedAt, { ...timing, status: "running" })])).toHaveLength(0);
});

it("can display the latest recorded time without fetching the off-page user anchor", () => {
  const page = [message("a1", "assistant", timing.completedAt!)];
  expect([...timelineTurnEnds(page, { messageId: "u1", timing })]).toEqual([["message:a1", timing]]);
  expect(timelineTurnEnds([message("older", "assistant", "2026-09-19T10:00:00Z")], { messageId: "u1", timing })).toHaveLength(0);
});

it("keeps the completion event when an older history-page response still says running", () => {
  const page = [message("u1", "user", timing.startedAt, { ...timing, status: "running" }), message("a1", "assistant", timing.completedAt!)];
  expect([...timelineTurnEnds(page, { messageId: "u1", timing })]).toEqual([["message:a1", timing]]);
});
