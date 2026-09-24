import { expect, it } from "vitest";
import type { Message, SessionGoal } from "../types";
import { findGoalMessageId } from "./TimelineEntries";

const goal: SessionGoal = {
  sessionId: "session-1",
  goal: "整理发布说明",
  status: "active",
  tokenBudget: null,
  usedTokens: 0,
  usedTimeMs: 0,
  createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z",
};

function message(id: string, role: Message["role"], content: string): Message {
  return {
    id,
    sessionId: "session-1",
    role,
    content,
    createdAt: "2026-09-24T00:00:00Z",
  };
}

it("marks the latest user message matching the active goal", () => {
  const messages = [
    message("old", "user", goal.goal),
    message("assistant", "assistant", goal.goal),
    message("latest", "user", ` ${goal.goal} `),
  ];

  expect(findGoalMessageId(messages, goal)).toBe("latest");
});

it("does not mark a message when there is no goal", () => {
  expect(findGoalMessageId([message("user", "user", goal.goal)], null)).toBeNull();
});