import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../types";
import {
  ExecutionPrelude,
  PlanProgress,
  ToolStep,
  toolActionLabel,
  toolDuration,
  turnProgressLabel,
} from "./ExecutionActivity";

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tool-1",
    sessionId: "session-1",
    toolName: "git_status",
    input: {},
    status: "succeeded",
    createdAt: "2026-09-03T01:00:00.000Z",
    completedAt: "2026-09-03T01:00:04.200Z",
    ...overrides,
  };
}

describe("execution activity", () => {
  it("uses clear action language instead of exposing internal tool names", () => {
    expect(toolActionLabel("git_status", true)).toBe("正在检查 Git 状态");
    const html = renderToStaticMarkup(
      <ToolStep call={toolCall()} onRollback={() => undefined} />,
    );
    expect(html).toContain("检查了 Git 状态");
    expect(html).not.toContain(">git_status<");
  });

  it("shows a useful elapsed time for completed steps", () => {
    expect(toolDuration(toolCall())).toBe("4 秒");
    expect(toolDuration(toolCall({ completedAt: undefined }))).toBeNull();
  });

  it("presents plans as an ordered inline progress list", () => {
    const html = renderToStaticMarkup(
      <PlanProgress
        plan={[
          { content: "检查现状", status: "completed" },
          { content: "调整时间线", status: "in_progress" },
          { content: "验证客户端", status: "pending" },
        ]}
      />,
    );
    expect(html).toContain("任务进度");
    expect(html).toContain("1/3");
    expect(html.indexOf("检查现状")).toBeLessThan(html.indexOf("调整时间线"));
    expect(html.indexOf("调整时间线")).toBeLessThan(html.indexOf("验证客户端"));
  });

  it("describes the observable model phase and round", () => {
    const progress = {
      phase: "receiving_model" as const,
      modelStep: 3,
      startedAt: new Date().toISOString(),
    };
    expect(turnProgressLabel(progress)).toBe("模型正在生成响应");

    const html = renderToStaticMarkup(
      <ExecutionPrelude plan={[]} progress={progress} />,
    );
    expect(html).toContain("模型正在生成响应");
    expect(html).toContain("第 3 轮");
    expect(html).toContain("已等待");
  });
});
