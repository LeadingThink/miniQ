// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ToolCall, ToolCallStatus, TurnTiming } from "../types";
import { compactDuration, executionSummary } from "../timelineTurns";
import { ExecutionFold } from "./ExecutionFold";

afterEach(cleanup);

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
  const toggle = screen.getByRole("button", { name: /已执行 2 步 · 用时 1分20秒/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("工具明细")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("region", { name: "本轮执行详情" }).textContent).toContain("工具明细");
  fireEvent.click(toggle);
  expect(screen.queryByText("工具明细")).toBeNull();
});

it("auto-expands on failures, pending approvals and questions", () => {
  const { rerender } = render(
    <ExecutionFold calls={[call("a", "succeeded"), call("b", "failed")]} timing={done} active={false}>
      <p>失败明细</p>
    </ExecutionFold>,
  );
  expect(screen.getByRole("button", { name: /1 步未成功/ }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("失败明细")).toBeTruthy();

  rerender(
    <ExecutionFold calls={[call("c", "waiting_approval")]} timing={{ startedAt: done.startedAt, status: "running" }} active>
      <p>审批卡片</p>
    </ExecutionFold>,
  );
  expect(screen.getByText("审批卡片")).toBeTruthy();
  expect(screen.getByRole("button", { name: /等待确认/ }).getAttribute("aria-expanded")).toBe("true");
});

it("keeps attention content visible and shows the live step while running", () => {
  render(
    <ExecutionFold calls={[call("a", "succeeded"), call("b", "running")]} timing={{ startedAt: done.startedAt, status: "running" }} active attention>
      <p>请回答问题</p>
    </ExecutionFold>,
  );
  const toggle = screen.getByRole("button", { expanded: true });
  expect(toggle.textContent).not.toContain("已执行");
  expect(screen.getByText("请回答问题")).toBeTruthy();
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
  expect(screen.getByRole("button", { name: "已执行 12 步 · 修改 3 个文件 · 用时 5秒" })).toBeTruthy();
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
