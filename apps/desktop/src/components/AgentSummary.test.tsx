// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStatusIndicator, type AgentSummary } from "./AgentSummary";

const base: AgentSummary = {
  agentId: "child",
  parentId: null,
  name: "研究子任务",
  description: "整理资料",
  status: "running",
  model: "gpt",
  createdAt: "2026-09-22T00:00:00Z",
  queuedMessages: 0,
  error: null,
  progress: {
    phase: "requesting_model",
    modelStep: 2,
    startedAt: "2026-09-22T00:00:00Z",
  },
};

afterEach(cleanup);

describe("AgentStatusIndicator", () => {
  it("shows compact counts and opens the existing activity panel", () => {
    const onOpen = vi.fn();
    render(
      <AgentStatusIndicator
        agents={[
          base,
          { ...base, agentId: "waiting", status: "waiting_approval" },
          { ...base, agentId: "failed", status: "failed" },
        ]}
        onOpen={onOpen}
      />,
    );

    const button = screen.getByRole("button", {
      name: "子任务：1 个执行中，1 个等待，1 个异常",
    });
    expect(button.textContent).toContain("1 执行中");
    expect(button.textContent).toContain("1 等待");
    expect(button.textContent).toContain("1 异常");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("does not render or poll when this session has no children", () => {
    const { container } = render(
      <AgentStatusIndicator agents={[]} onOpen={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("counts retrying once and does not describe cancelled children as completed", () => {
    render(<AgentStatusIndicator agents={[
      { ...base, progress: { phase: "waiting_retry", startedAt: base.createdAt, modelStep: 3 } },
      { ...base, agentId: "cancelled", status: "cancelled" },
      // The last progress snapshot may remain after the agent has finished.
      { ...base, agentId: "done", status: "completed", progress: { phase: "waiting_retry", startedAt: base.createdAt } },
    ]} onOpen={vi.fn()} />);
    const button = screen.getByRole("button", {
      name: "子任务：0 个执行中，1 个等待，0 个异常，1 个已完成，1 个已取消",
    });
    expect(button.textContent).toContain("等待重试 · 第 3 轮");
    expect(button.textContent).not.toContain("执行中");
  });
});
