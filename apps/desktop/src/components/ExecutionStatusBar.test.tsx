// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message, PlanTask, ToolCall } from "../types";
import { ToolGroup } from "./ToolGroup";
import { ExecutionStatusBar, STEP_SLOW_MS } from "./ExecutionStatusBar";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const call = (id: number, status = "succeeded") =>
  ({
    id: String(id),
    toolName: `tool_${id}`,
    input: {},
    status,
    createdAt: `2026-09-08T00:00:${String(id % 60).padStart(2, "0")}Z`,
  }) as ToolCall;
it("excludes historical actions and finished calls from the current status", () => {
  const messages = [{ role: "user", createdAt: "2026-09-08T00:00:01.000001Z" }] as Message[];
  render(<ExecutionStatusBar messages={messages}
    calls={[call(0, "running"), call(1, "running"), call(2, "running"), call(3, "cancelled"), call(4, "failed")]}
    progress={null} plan={[]} busy approvals={0} questions={0} />);
  expect(screen.getByRole("status").textContent).toBe("正在执行 tool_2");
});
it("shows approvals ahead of model activity", () => {
  render(
    <ExecutionStatusBar
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
  expect(document.querySelector(".activity-spinner")).toBeNull();
  expect(screen.queryByText(/执行中/)).toBeNull();
});

it("hides the live status after the turn ends", () => {
  render(
    <ExecutionStatusBar
      messages={[{ role: "user", createdAt: "2026-09-08T00:00:00Z" } as Message]}
      calls={[call(1)]}
      progress={null}
      plan={[]}
      busy={false}
      approvals={0}
      questions={0}
    />,
  );
  expect(screen.queryByLabelText("当前任务状态")).toBeNull();
});

it("does not expose internal plan updates as the current action", () => {
  render(<ExecutionStatusBar messages={[]} calls={[call(1, "running"), { ...call(2, "running"), toolName: "task_update" }]}
    progress={null} plan={[]} busy approvals={0} questions={0} />);
  expect(screen.getByRole("status").textContent).toBe("正在执行 tool_1");
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

it("shows automation activity and the latest observation by default", () => {
  const calls = [
    { ...call(1), toolName: "computer_use", input: { action: "screenshot" } },
    { ...call(2), toolName: "computer_use", input: { action: "drag", x: 10, y: 20, endX: 10, endY: 220 } },
  ];
  render(<ToolGroup calls={calls} onRollback={() => {}} />);
  expect(screen.getByText("2 次桌面")).toBeTruthy();
  expect(screen.getByText("观察了桌面")).toBeTruthy();
  expect(screen.getAllByText("向下拖动 200 px · (10, 20) -> (10, 220)")).toHaveLength(2);
  expect(screen.getByText("查看调用数据")).toBeTruthy();
});

it("expands the complete plan from a static step button and hides it when idle", () => {
  const plan = [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "pending" },
  ] as PlanTask[];
  const { rerender } = render(
    <ExecutionStatusBar messages={[]} calls={[]} progress={null} plan={plan} busy approvals={0} questions={0} />,
  );
  const toggle = screen.getByRole("button", { name: "步骤 2/3，已完成 1 个步骤" });
  expect(toggle.querySelector(".activity-spinner")).toBeNull();
  expect(screen.queryByText("a")).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole("region", { name: "任务步骤详情" }).textContent).toBe("abc");
  expect(document.querySelectorAll(".activity-spinner")).toHaveLength(1);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "任务步骤详情" })).toBeNull();
  expect(document.activeElement).toBe(toggle);
  fireEvent.click(toggle);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("region", { name: "任务步骤详情" })).toBeNull();
  fireEvent.click(toggle);
  rerender(<ExecutionStatusBar messages={[]} calls={[call(1)]} progress={null} plan={plan} busy={false} approvals={0} questions={0} />);
  expect(screen.queryByLabelText(/^步骤 /)).toBeNull();
  rerender(<ExecutionStatusBar messages={[]} calls={[]} progress={null} plan={plan} busy approvals={0} questions={0} />);
  expect(screen.queryByRole("region", { name: "任务步骤详情" })).toBeNull();
});

it("shows the model phase and full task text without truncating the plan", () => {
  const content = "读取项目、文件和验证请求模型，并确定可压测接口".repeat(20);
  render(<ExecutionStatusBar messages={[]} calls={[]} busy approvals={0} questions={0}
    progress={{ phase: "compacting_context", startedAt: new Date().toISOString() }}
    plan={[{ content, status: "in_progress" }]} />);
  expect(screen.getByRole("status").textContent).toBe("正在整理较长的会话上下文");
  expect(screen.getByText(content)).toBeTruthy();
  expect(screen.queryByText(/阶段 /)).toBeNull();
});

it("shows an action-specific tool label and gives questions priority", () => {
  const calls = [{ ...call(1, "running"), toolName: "computer_use", input: { action: "click", x: 10, y: 20 } }];
  const props = { messages: [], calls, plan: [], progress: null, busy: true, approvals: 0, questions: 0 };
  const view = render(<ExecutionStatusBar {...props} />);
  expect(screen.getByRole("status").textContent).toBe("正在点击桌面");
  view.rerender(<ExecutionStatusBar {...props} questions={1} />);
  expect(screen.getByRole("status").textContent).toBe("等待你的回答");
  expect(document.querySelector(".activity-spinner")).toBeNull();
});

it("keeps total timing stable across phases and clears clocks when work ends", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:30Z"));
  const props = { messages: [], calls: [], plan: [], busy: true, approvals: 0, questions: 0,
    timing: { messageId: "user", timing: { status: "running" as const, startedAt: "2026-09-08T00:00:00Z" } } };
  const view = render(<ExecutionStatusBar {...props} progress={{ phase: "requesting_model", startedAt: "2026-09-08T00:00:29Z" }} />);
  expect(screen.getByText("总用时 30 秒")).toBeTruthy();
  view.rerender(<ExecutionStatusBar {...props} progress={{ phase: "receiving_model", startedAt: "2026-09-08T00:00:30Z" }} />);
  expect(screen.getByText("总用时 30 秒")).toBeTruthy();
  view.rerender(<ExecutionStatusBar {...props} progress={null} busy={false} />);
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.queryByLabelText("当前任务状态")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows a live step clock next to the total and flags a stalled step", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:10:00Z"));
  const timing = { messageId: "user", timing: { status: "running" as const, startedAt: "2026-09-08T00:00:00Z" } };
  const running = { ...call(1, "running"), createdAt: "2026-09-08T00:09:50Z" };
  const props = { messages: [], plan: [], progress: null, busy: true, approvals: 0, questions: 0, timing };
  const view = render(<ExecutionStatusBar {...props} calls={[running]} />);
  expect(screen.getByText("当前操作 10 秒")).toBeTruthy();
  expect(screen.getByText("总用时 10 分")).toBeTruthy();
  expect(document.querySelector(".execution-status-step")?.getAttribute("data-slow")).toBeNull();

  act(() => vi.advanceTimersByTime(STEP_SLOW_MS));
  const step = document.querySelector(".execution-status-step");
  expect(step?.getAttribute("data-slow")).toBe("true");
  expect(step?.getAttribute("title")).toContain("卡住");

  // A new model phase restarts the step clock and clears the warning.
  view.rerender(<ExecutionStatusBar {...props} calls={[]}
    progress={{ phase: "requesting_model", startedAt: new Date().toISOString() }} />);
  const restarted = document.querySelector(".execution-status-step");
  expect(restarted?.textContent).toMatch(/^当前步骤/);
  expect(restarted?.getAttribute("data-slow")).toBeNull();
  vi.useRealTimers();
});
