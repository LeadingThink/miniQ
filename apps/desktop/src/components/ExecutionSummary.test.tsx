// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Message, ToolCall } from "../types";
import { currentExecution } from "../timelineModel";
import { ToolGroup } from "./ToolGroup";
import { ExecutionSummary } from "./ExecutionSummary";

afterEach(cleanup);
const call = (id: number, status = "succeeded") =>
  ({
    id: String(id),
    toolName: `tool_${id}`,
    input: {},
    status,
    createdAt: `2026-09-08T00:00:${String(id % 60).padStart(2, "0")}Z`,
  }) as ToolCall;
it("keeps current-turn counts separate and does not label cancellation as failure", () => {
  const messages = [{ role: "user", createdAt: "2026-09-08T00:00:01.000001Z" }] as Message[];
  const summary = currentExecution(messages, [
    call(0),
    call(1),
    call(2),
    call(3, "cancelled"),
    call(4, "failed"),
    call(5, "waiting_approval"),
  ]);
  expect(summary).toMatchObject({
    completed: 1,
    cancelled: 1,
    failed: 1,
    waiting: 1,
    partial: false,
  });
});
it("shows approvals ahead of model activity", () => {
  render(
    <ExecutionSummary
      messages={[]}
      calls={[call(1, "waiting_approval")]}
      progress={null}
      plan={[]}
      busy
      approvals={1}
      questions={0}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("等待操作确认");
  expect(screen.getByText("1 待确认")).toBeTruthy();
  expect(screen.queryByText(/执行中/)).toBeNull();
});

it("excludes internal plan updates from visible step counts", () => {
  expect(currentExecution([], [{ ...call(1), toolName: "task_update" }, call(2)]).completed).toBe(1);
});

it("does not move away from a historical page when new tools arrive", () => {
  const calls = Array.from({ length: 75 }, (_, index) => call(index));
  const props = { onRollback: () => {}, expanded: true };
  const view = render(<ToolGroup calls={calls} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "下一页步骤" }));
  view.rerender(<ToolGroup calls={[...calls, call(75, "running")]} {...props} />);
  expect(screen.getByText("31-60 / 76")).toBeTruthy();
  expect(screen.queryByText("正在执行 tool_75")).toBeNull();
});
it("navigates all tool pages to active and failed steps without dropping history", () => {
  const calls = Array.from({ length: 75 }, (_, i) => call(i, i === 35 ? "failed" : i === 74 ? "running" : "succeeded"));
  render(<ToolGroup calls={calls} onRollback={() => {}} expanded />);
  fireEvent.click(screen.getByRole("button", { name: "定位当前步骤" }));
  expect(screen.getByText("正在执行 tool_74")).toBeTruthy();
  expect(screen.getByText("61-75 / 75")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "定位失败步骤" }));
  expect(screen.getByText("已执行 tool_35")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "上一页步骤" }));
  expect(screen.getByText("已执行 tool_0")).toBeTruthy();
});
