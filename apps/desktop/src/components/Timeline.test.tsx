import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message, Question, ToolCall, TurnProgress } from "../types";
import { Timeline } from "./Timeline";

const noop = () => undefined;

function renderTimeline(options: {
  messages?: Message[];
  toolCalls?: ToolCall[];
  busy?: boolean;
  streamingText?: string;
  turnProgress?: TurnProgress | null;
  plan?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  questions?: Question[];
}) {
  return renderToStaticMarkup(
    <Timeline
      messages={options.messages ?? []}
      toolCalls={options.toolCalls ?? []}
      approvals={[]}
      questions={options.questions ?? []}
      plan={options.plan ?? []}
      artifacts={[]}
      queue={[]}
      streamingText={options.streamingText ?? ""}
      turnProgress={options.turnProgress ?? null}
      busy={options.busy ?? false}
      onResolveApproval={noop}
      onResolveQuestion={noop}
      onRollback={noop}
      onOpenFile={noop}
      onOpenUrl={noop}
      onSteerQueued={noop}
      onRemoveQueued={noop}
      onError={noop}
    />,
  );
}

describe("Timeline execution flow", () => {
  it("keeps execution steps in chronological order below the request", () => {
    const messages: Message[] = [
      {
        id: "user-1",
        sessionId: "session-1",
        role: "user",
        content: "检查这个项目",
        createdAt: "2026-09-03T01:00:00Z",
      },
      {
        id: "assistant-1",
        sessionId: "session-1",
        role: "assistant",
        content: "检查完成",
        createdAt: "2026-09-03T01:00:03Z",
      },
    ];
    const toolCalls: ToolCall[] = [
      {
        id: "plan-1",
        sessionId: "session-1",
        toolName: "task_update",
        input: {},
        status: "succeeded",
        createdAt: "2026-09-03T01:00:01Z",
      },
      {
        id: "tool-1",
        sessionId: "session-1",
        toolName: "shell_run",
        input: { command: "npm test" },
        status: "succeeded",
        createdAt: "2026-09-03T01:00:02Z",
      },
    ];
    const html = renderTimeline({
      messages,
      toolCalls,
      plan: [{ content: "验证结果", status: "completed" }],
    });

    expect(html.indexOf("检查这个项目")).toBeLessThan(html.indexOf("运行了命令"));
    expect(html.indexOf("运行了命令")).toBeLessThan(html.indexOf("检查完成"));
    expect(html.indexOf("检查完成")).toBeLessThan(html.indexOf("任务步骤已完成"));
    expect(html).not.toContain("task_update");
  });

  it("shows a descriptive prelude before the first execution step", () => {
    const html = renderTimeline({ busy: true });
    expect(html).toContain("正在分析并准备下一步");
  });

  it("keeps the real model phase visible after earlier streamed text", () => {
    const html = renderTimeline({
      busy: true,
      streamingText: "已经完成前一阶段。",
      turnProgress: {
        phase: "requesting_model",
        modelStep: 4,
        startedAt: new Date().toISOString(),
      },
    });

    expect(html).toContain("已经完成前一阶段。");
    expect(html).toContain("正在将执行结果交给模型");
    expect(html).toContain("第 4 轮");
  });

  it("renders native question headings, option details, and multi-select controls", () => {
    const html = renderTimeline({
      questions: [
        {
          id: "question-1",
          sessionId: "session-1",
          toolCallId: "tool-1",
          prompt: "选择要检查的平台",
          header: "平台",
          options: ["macOS", "Windows"],
          optionDescriptions: {
            macOS: "检查 Apple Silicon",
            Windows: "检查 x64 安装包",
          },
          multiSelect: true,
          createdAt: "2026-09-04T01:00:00Z",
        },
      ],
    });

    expect(html).toContain("平台");
    expect(html).toContain("检查 Apple Silicon");
    expect(html).toContain("检查 x64 安装包");
    expect(html).toContain("确认选择");
    expect(html).toContain('aria-pressed="false"');
  });
});
