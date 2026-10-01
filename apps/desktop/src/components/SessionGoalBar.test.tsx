// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { SessionGoal } from "../types";
import { SessionGoalBar } from "./SessionGoalBar";

afterEach(cleanup);

it("hides a goal belonging to another session", () => {
  render(<SessionGoalBar sessionId="session-2" goal={savedGoal} onPauseTurn={vi.fn()} onResumeTurn={vi.fn()} onCancelTurn={vi.fn()} onError={vi.fn()} />);
  expect(screen.queryByTestId("session-goal")).toBeNull();
});

it("ignores a completed action after switching sessions", async () => {
  let resolve!: (goal: SessionGoal) => void;
  const call = vi.fn(() => new Promise<SessionGoal>((done) => { resolve = done; }));
  const callbacks = { onPauseTurn: vi.fn(), onResumeTurn: vi.fn(), onCancelTurn: vi.fn(), onError: vi.fn() };
  const client = { call } as unknown as RpcClient;
  const view = render(<SessionGoalBar client={client} sessionId="session-1" goal={savedGoal} {...callbacks} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "暂停" })); });
  const secondGoal = { ...savedGoal, sessionId: "session-2", goal: "第二个会话目标" };
  view.rerender(<SessionGoalBar client={client} sessionId="session-2" goal={secondGoal} {...callbacks} />);
  await act(async () => { resolve({ ...savedGoal, status: "paused", updatedAt: "2026-09-24T00:00:02Z" }); });
  expect(screen.getByText("第二个会话目标")).toBeTruthy();
  expect(screen.getByText("执行中")).toBeTruthy();
  expect(screen.queryByText("已暂停")).toBeNull();
});

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
