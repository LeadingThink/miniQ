// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, Question, ToolCall, TurnProgress } from "../types";
import type { PendingApproval } from "../hooks/useSessionFeed";
import { Timeline } from "./Timeline";
import { QueueBar } from "./TimelineInteractions";

const noop = () => undefined;

afterEach(cleanup);

function renderTimeline(options: {
  messages?: Message[];
  toolCalls?: ToolCall[];
  busy?: boolean;
  streamingText?: string;
  turnProgress?: TurnProgress | null;
  plan?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  questions?: Question[];
  approvals?: PendingApproval[];
}) {
  return renderToStaticMarkup(
    <Timeline
      messages={options.messages ?? []}
      toolCalls={options.toolCalls ?? []}
      approvals={options.approvals ?? []}
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
      onRewrite={async () => true}
      onError={noop}
    />,
  );
}

describe("Timeline execution flow", () => {
  it("renders copy controls after complete user and assistant content", () => {
    const html = renderTimeline({
      messages: [
        {
          id: "user-copy",
          sessionId: "session-1",
          role: "user",
          content: "你好",
          createdAt: "2026-09-08T00:00:00Z",
        },
        {
          id: "assistant-copy",
          sessionId: "session-1",
          role: "assistant",
          content: "你好，有什么需要我帮你处理的？",
          createdAt: "2026-09-08T00:00:01Z",
        },
      ],
    });

    expect(html).toMatch(/class="bubble user"[^>]*><div>你好<\/div><div class="message-actions"><span class="copy-control">/);
    expect(html).toContain('aria-label="修改消息"');
    expect(html).toMatch(/你好，有什么需要我帮你处理的？<\/p><\/div><div class="message-actions assistant-actions"><span class="copy-control">/);
    expect(html.indexOf('aria-label="复制消息"', html.indexOf("bubble assistant")))
      .toBeLessThan(html.indexOf('aria-label="重新生成"'));
  });

  it("regenerates an assistant reply from its preceding user message", async () => {
    const onRewrite = vi.fn().mockResolvedValue(true);
    render(
      <Timeline
        messages={[
          {
            id: "user-source",
            sessionId: "session-1",
            role: "user",
            content: "原问题",
            attachments: [{ path: "C:\\work\\context.txt", name: "context.txt" }],
            createdAt: "2026-09-08T00:00:00Z",
          },
          {
            id: "assistant-reply",
            sessionId: "session-1",
            role: "assistant",
            content: "原回答",
            createdAt: "2026-09-08T00:00:01Z",
          },
        ]}
        toolCalls={[]}
        approvals={[]}
        questions={[]}
        plan={[]}
        artifacts={[]}
        queue={[]}
        streamingText=""
        turnProgress={null}
        busy={false}
        onResolveApproval={noop}
        onResolveQuestion={noop}
        onRollback={noop}
        onOpenFile={noop}
        onOpenUrl={noop}
        onSteerQueued={noop}
        onRemoveQueued={noop}
        onRewrite={onRewrite}
        onError={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));

    await waitFor(() => expect(onRewrite).toHaveBeenCalledWith(
      "user-source",
      "原问题",
      ["C:\\work\\context.txt"],
    ));
  });

  it("disables message rewrites while a turn is active", () => {
    const onRewrite = vi.fn().mockResolvedValue(true);
    render(
      <Timeline
        messages={[
          {
            id: "user-source",
            sessionId: "session-1",
            role: "user",
            content: "原问题",
            createdAt: "2026-09-08T00:00:00Z",
          },
          {
            id: "assistant-reply",
            sessionId: "session-1",
            role: "assistant",
            content: "正在回答",
            createdAt: "2026-09-08T00:00:01Z",
          },
        ]}
        toolCalls={[]}
        approvals={[]}
        questions={[]}
        plan={[]}
        artifacts={[]}
        queue={[]}
        streamingText=""
        turnProgress={null}
        busy
        onResolveApproval={noop}
        onResolveQuestion={noop}
        onRollback={noop}
        onOpenFile={noop}
        onOpenUrl={noop}
        onSteerQueued={noop}
        onRemoveQueued={noop}
        onRewrite={onRewrite}
        onError={noop}
      />,
    );

    const editButton = screen.getByRole("button", { name: "修改消息" });
    const regenerateButton = screen.getByRole("button", { name: "重新生成" });
    expect((editButton as HTMLButtonElement).disabled).toBe(true);
    expect((regenerateButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(editButton);
    fireEvent.click(regenerateButton);
    expect(onRewrite).not.toHaveBeenCalled();
  });

  it("rewrites a user message in place with its attachments", async () => {
    const onRewrite = vi.fn().mockResolvedValue(true);
    render(
      <Timeline
        messages={[{
          id: "user-edit",
          sessionId: "session-1",
          role: "user",
          content: "原内容",
          attachments: [{ path: "C:\\work\\context.txt", name: "context.txt" }],
          createdAt: "2026-09-08T00:00:00Z",
        }]}
        toolCalls={[]}
        approvals={[]}
        questions={[]}
        plan={[]}
        artifacts={[]}
        queue={[]}
        streamingText=""
        turnProgress={null}
        busy={false}
        onResolveApproval={noop}
        onResolveQuestion={noop}
        onRollback={noop}
        onOpenFile={noop}
        onOpenUrl={noop}
        onSteerQueued={noop}
        onRemoveQueued={noop}
        onRewrite={onRewrite}
        onError={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "修改消息" }));
    fireEvent.change(screen.getByRole("textbox", { name: "修改消息内容" }), {
      target: { value: "修改后的内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送修改" }));

    await waitFor(() => expect(onRewrite).toHaveBeenCalledWith(
      "user-edit",
      "修改后的内容",
      ["C:\\work\\context.txt"],
    ));
  });

  it("shows attachment names for a queued attachment-only message", () => {
    const html = renderToStaticMarkup(
      <QueueBar
        queue={[{
          id: "queued-1",
          sessionId: "session-1",
          content: "",
          attachments: [
            { path: "C:\\work\\report.pdf", name: "report.pdf" },
            { path: "C:\\work\\notes.txt", name: "notes.txt" },
          ],
          position: 0,
          createdAt: "2026-09-08T00:00:00Z",
        }]}
        onSteer={noop}
        onRemove={noop}
      />,
    );

    expect(html).toContain("report.pdf、notes.txt");
  });

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

  it("restores an ended plan without claiming completion or spinning forever", () => {
    const plan = [{ content: "render video", status: "in_progress" as const }];
    expect(renderTimeline({ plan, busy: false })).toContain("本轮已结束，步骤待核对");
    expect(renderTimeline({ plan, busy: false })).not.toContain("activity-spinner");
    expect(renderTimeline({ plan, busy: true })).toContain("activity-spinner");
    expect(renderTimeline({ plan, busy: true })).not.toContain("本轮已结束");
  });

  it("shows retries alongside active tools but not for an idle session", () => {
    const turnProgress: TurnProgress = {
      phase: "waiting_retry",
      modelStep: 2,
      startedAt: new Date().toISOString(),
      retry: { attempt: 1, maxAttempts: 4, delayMs: 60000 },
    };
    const toolCalls: ToolCall[] = [{
      id: "background-tool", sessionId: "session-1", toolName: "agent_run",
      input: {}, status: "running", createdAt: new Date().toISOString(),
    }];
    expect(renderTimeline({ busy: true, toolCalls, turnProgress })).toContain("自动重试 1/4");
    expect(renderTimeline({ busy: false, toolCalls, turnProgress })).not.toContain("自动重试");
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
    expect(html).toContain("确认回答");
    expect(html).toContain('type="checkbox"');
  });

  it("renders actions for a pending tool approval", () => {
    const html = renderTimeline({
      busy: true,
      approvals: [
        {
          approval: {
            id: "approval-1",
            sessionId: "session-1",
            toolCallId: "tool-1",
            riskLevel: "high",
            status: "pending",
            reason: "trusted Node plugin executes with the current user account",
            createdAt: "2026-09-03T01:00:02Z",
          },
          toolName: "dev.miniq.text-utils.transform",
          input: { text: "Hello, miniQ!", mode: "uppercase" },
        },
      ],
    });

    expect(html).toContain("dev.miniq.text-utils.transform");
    expect(html).toContain("允许一次");
    expect(html).toContain("本会话允许");
    expect(html).toContain("拒绝");
  });
});
