// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { SessionGoal } from "../types";
import { SessionGoalBar } from "./SessionGoalBar";

afterEach(cleanup);

const savedGoal: SessionGoal = {
  sessionId: "session-1",
  goal: "检查代码中的 final 引用",
  status: "active",
  tokenBudget: null,
  usedTokens: 7560,
  usedTimeMs: 12000,
  createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:01Z",
};

it("stays hidden without a goal", () => {
  render(
    <SessionGoalBar
      sessionId="session-1"
      onPauseTurn={vi.fn()}
      onResumeTurn={vi.fn()}
      onCancelTurn={vi.fn()}
      onError={vi.fn()}
    />,
  );
  expect(screen.queryByTestId("session-goal")).toBeNull();
});

it("pauses the active turn without cancelling it", async () => {
  const call = vi.fn()
    .mockResolvedValueOnce({
      ...savedGoal,
      status: "paused",
      updatedAt: "2026-09-24T00:00:02Z",
    });
  const pauseTurn = vi.fn().mockResolvedValue(undefined);
  const cancelTurn = vi.fn().mockResolvedValue(undefined);
  render(
    <SessionGoalBar
      client={{ call } as unknown as RpcClient}
      sessionId="session-1"
      goal={savedGoal}
      onPauseTurn={pauseTurn}
      onResumeTurn={vi.fn()}
      onCancelTurn={cancelTurn}
      onError={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  expect(await screen.findByText("已暂停")).toBeTruthy();
  expect(pauseTurn).toHaveBeenCalledOnce();
  expect(cancelTurn).not.toHaveBeenCalled();
  expect(pauseTurn.mock.invocationCallOrder[0]).toBeLessThan(
    call.mock.invocationCallOrder[0],
  );
  expect(call).toHaveBeenLastCalledWith("session.goal.update", {
    sessionId: "session-1",
    goal: savedGoal.goal,
    status: "paused",
    tokenBudget: null,
  });
});

it("resumes the turn before storing the active status", async () => {
  const pausedGoal = { ...savedGoal, status: "paused" as const };
  const call = vi.fn().mockResolvedValue({
    ...savedGoal,
    updatedAt: "2026-09-24T00:00:03Z",
  });
  const resumeTurn = vi.fn().mockResolvedValue(undefined);
  render(
    <SessionGoalBar
      client={{ call } as unknown as RpcClient}
      sessionId="session-1"
      goal={pausedGoal}
      onPauseTurn={vi.fn()}
      onResumeTurn={resumeTurn}
      onCancelTurn={vi.fn()}
      onError={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  expect(await screen.findByText("执行中")).toBeTruthy();
  expect(resumeTurn).toHaveBeenCalledOnce();
  expect(resumeTurn.mock.invocationCallOrder[0]).toBeLessThan(
    call.mock.invocationCallOrder[0],
  );
  expect(call).toHaveBeenLastCalledWith("session.goal.update", {
    sessionId: "session-1",
    goal: savedGoal.goal,
    status: "active",
    tokenBudget: null,
  });
});

it("stops the active turn before cancelling a goal", async () => {
  const call = vi.fn().mockResolvedValue({
    ...savedGoal,
    status: "cancelled",
  });
  const cancelTurn = vi.fn().mockResolvedValue(undefined);
  render(
    <SessionGoalBar
      client={{ call } as unknown as RpcClient}
      sessionId="session-1"
      goal={savedGoal}
      onPauseTurn={vi.fn()}
      onResumeTurn={vi.fn()}
      onCancelTurn={cancelTurn}
      onError={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(await screen.findByText("已取消")).toBeTruthy();
  expect(cancelTurn).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
});