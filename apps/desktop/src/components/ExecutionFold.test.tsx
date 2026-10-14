// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolCall, ToolCallStatus, TurnTiming } from "../types";
import { compactDuration, executionSummary } from "../timelineTurns";
import { ExecutionFold } from "./ExecutionFold";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function call(id: string, status: ToolCallStatus, toolName = "shell_exec"): ToolCall {
  return { id, sessionId: "s", toolName, input: { command: "ls" }, status, createdAt: "2026-09-20T00:00:00Z" };
}

const done: TurnTiming = {
  startedAt: "2026-09-20T00:00:00Z",
  completedAt: "2026-09-20T00:01:20Z",
  status: "completed",
};

it("collapses a finished turn into one summary row and toggles details", () => {
  render(
    <ExecutionFold calls={[call("a", "succeeded"), call("b", "succeeded")]} timing={done} active={false}>
      <p>工具明细</p>
    </ExecutionFold>,
  );
  const toggle = screen.getByRole("button", { name: /已执行 2 项操作 · 用时 1分20秒/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("工具明细")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const region = screen.getByRole("region", { name: "当前阶段的执行详情" });
  expect(region.textContent).toContain("工具明细");
  // Start and end live in one compact line; the duration is only in the header.
  const details = region.querySelector(".turn-timing-details");
  expect(details?.textContent).toMatch(/^开始 .+ · 结束 .+$/);
  expect(details?.querySelectorAll("time")).toHaveLength(2);
  expect(region.textContent).not.toContain("用时");
  fireEvent.click(toggle);
  expect(screen.queryByText("工具明细")).toBeNull();
});

it("keeps failures and pending approvals collapsed until clicked", () => {
  const { rerender } = render(
    <ExecutionFold calls={[call("a", "succeeded"), call("b", "failed")]} timing={done} active={false}>
      <p>失败明细</p>
    </ExecutionFold>,
  );
  expect(screen.getByRole("button", { name: /1 项操作失败/ }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("失败明细")).toBeNull();

  rerender(
    <ExecutionFold calls={[call("c", "waiting_approval")]} timing={{ startedAt: done.startedAt, status: "running" }} active>
      <p>审批卡片</p>
    </ExecutionFold>,
  );
  expect(screen.queryByText("审批卡片")).toBeNull();
  const toggle = screen.getByRole("button", { name: /等待确认/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByText("审批卡片")).toBeTruthy();
});

it("keeps questions collapsed and displays their waiting state in the summary", () => {
  render(
    <ExecutionFold calls={[call("a", "succeeded"), call("b", "running")]} timing={{ startedAt: done.startedAt, status: "running" }} active attention>
      <p>请回答问题</p>
    </ExecutionFold>,
  );
  const toggle = screen.getByRole("button", { expanded: false });
  expect(toggle.textContent).toContain("执行记录 · 1 项已完成");
  expect(toggle.querySelector(".spin")).toBeNull();
  expect(toggle.textContent).not.toContain("正在运行");
  expect(toggle.textContent).toContain("等待回复");
  expect(screen.queryByText("请回答问题")).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText("请回答问题")).toBeTruthy();
});

it("does not reopen details when a running operation fails after manual collapse", () => {
  const { rerender } = render(
    <ExecutionFold calls={[call("a", "running")]} active><p>操作明细</p></ExecutionFold>,
  );
  const toggle = screen.getByRole("button");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByText("操作明细")).toBeTruthy();
  fireEvent.click(toggle);
  rerender(<ExecutionFold calls={[call("a", "failed")]} active={false}><p>操作明细</p></ExecutionFold>);
  expect(screen.getByRole("button", { name: /1 项操作失败/ }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("操作明细")).toBeNull();
});

it("prefers the daemon turn summary over locally derived counts", () => {
  const timing: TurnTiming = {
    ...done,
    summary: { toolCalls: 12, failedToolCalls: 0, filesChanged: 3, durationMs: 5_000, status: "completed" },
  };
  render(
    <ExecutionFold calls={[call("a", "succeeded")]} timing={timing} active={false}>
      <p>明细</p>
    </ExecutionFold>,
  );
  expect(screen.getByRole("button", { name: "已执行 12 项操作 · 修改 3 个文件 · 用时 5秒" })).toBeTruthy();
});

it("tags stopped turns", () => {
  render(
    <ExecutionFold calls={[call("a", "cancelled")]} timing={{ ...done, status: "cancelled" }} active={false}>
      <p>明细</p>
    </ExecutionFold>,
  );
  expect(screen.getByText("已停止")).toBeTruthy();
});

it("summarizes calls and formats compact durations", () => {
  const data = executionSummary([call("a", "succeeded"), call("b", "rejected"), call("c", "waiting_approval")], done);
  expect(data).toMatchObject({ steps: 3, failed: 1, waitingApproval: true, running: true, durationMs: 80_000 });
  expect(compactDuration(400)).toBe("不足1秒");
  expect(compactDuration(45_000)).toBe("45秒");
  expect(compactDuration(120_000)).toBe("2分");
  expect(compactDuration(3_780_000)).toBe("1小时3分");
});

it("shows a live 用时 only for the running turn and freezes it when the turn ends", () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-20T00:01:05Z");
  const running: TurnTiming = { startedAt: done.startedAt, status: "running" };
  const { rerender } = render(
    <ExecutionFold calls={[call("a", "succeeded"), call("b", "running")]} timing={running} active>
      <p>明细</p>
    </ExecutionFold>,
  );
  const toggle = () => screen.getByRole("button");
  expect(toggle().textContent).toBe("执行记录 · 1 项已完成 · 用时 1分5秒");
  act(() => { vi.advanceTimersByTime(2_000); });
  expect(toggle().textContent).toBe("执行记录 · 1 项已完成 · 用时 1分7秒");
  // An older turn that still reports running is not this run: no clock.
  rerender(
    <ExecutionFold calls={[call("a", "succeeded")]} timing={running} active={false}>
      <p>明细</p>
    </ExecutionFold>,
  );
  expect(vi.getTimerCount()).toBe(0);
  rerender(
    <ExecutionFold calls={[call("a", "succeeded"), call("b", "succeeded")]} timing={{ ...done, elapsedMs: 67_000 }} active={false}>
      <p>明细</p>
    </ExecutionFold>,
  );
  expect(toggle().textContent).toBe("已执行 2 项操作 · 用时 1分7秒");
  expect(vi.getTimerCount()).toBe(0);
});

it("says an interrupted turn has no end time instead of inventing a duration", () => {
  render(
    <ExecutionFold calls={[call("a", "succeeded")]} timing={{ startedAt: done.startedAt, status: "interrupted" }} active={false}>
      <p>明细</p>
    </ExecutionFold>,
  );
  expect(screen.getByRole("button").textContent).toBe("已执行 1 项操作");
  fireEvent.click(screen.getByRole("button"));
  expect(document.querySelector(".turn-timing-details")?.textContent).toMatch(/已中断，未记录结束时间$/);
});
