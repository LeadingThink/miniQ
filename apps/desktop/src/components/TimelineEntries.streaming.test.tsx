// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingApproval } from "../hooks/useSessionFeed";
import type { Message } from "../types";

const rendered: string[] = [];
vi.mock("./Md", () => ({
  Md: (props: { children: string; streaming?: boolean }) => {
    rendered.push(props.children);
    return <div data-streaming={props.streaming ? "" : undefined}>{props.children}</div>;
  },
}));

const { Timeline } = await import("./Timeline");

afterEach(cleanup);

const noop = () => undefined;
const asyncNoop = async () => undefined;

function message(id: string, role: Message["role"], content: string): Message {
  return { id, sessionId: "s", role, content, createdAt: "2026-01-01T00:00:00Z" };
}

const messages = Array.from({ length: 20 }, (_, index) =>
  message(`m${index}`, index % 2 ? "assistant" : "user", `历史回复 ${index}`),
);

// The session feed reducer keeps these identities while only streamingText grows.
const none: never[] = [];

const approval: PendingApproval = {
  approval: {
    id: "approval-1", sessionId: "s", toolCallId: "tool-1", riskLevel: "high",
    status: "pending", reason: "需要确认", createdAt: "2026-01-01T00:00:02Z",
  },
  toolName: "shell_exec",
  input: { command: "ls" },
};

function view(streamingText: string, options: { onOpenFile?: () => void; history?: Message[]; approvals?: PendingApproval[] } = {}) {
  return (
    <Timeline
      messages={options.history ?? messages}
      toolCalls={none}
      approvals={options.approvals ?? none}
      questions={none}
      plan={none}
      artifacts={none}
      queue={none}
      streamingText={streamingText}
      turnProgress={null}
      busy
      onResolveApproval={noop}
      onResolveQuestion={noop}
      onRollback={noop}
      onOpenFile={options.onOpenFile ?? noop}
      onOpenUrl={noop}
      onSteerQueued={asyncNoop}
      onRemoveQueued={asyncNoop}
      onUpdateQueued={asyncNoop}
      onRewrite={async () => true}
      onError={noop}
    />
  );
}

it("streams new tokens without re-rendering completed history", () => {
  const { rerender } = render(view("正在"));
  expect(screen.getByText("历史回复 19")).toBeTruthy();
  rendered.length = 0;
  // Parents commonly pass fresh callback identities on every token.
  rerender(view("正在生成", { onOpenFile: () => undefined }));
  rerender(view("正在生成回复", { onOpenFile: () => undefined }));
  expect(rendered).toEqual(["正在生成", "正在生成回复"]);
});

it("streams inside the current turn, above approval cards, where the reply lands", () => {
  const history = [...messages, message("m20", "user", "新的问题")];
  const { container, rerender } = render(view("正在回答", { history, approvals: [approval] }));
  const turns = container.querySelectorAll(".timeline-turn");
  const current = turns[turns.length - 1];
  const bubble = screen.getByText("正在回答").closest(".message-entry")!;
  expect(bubble.getAttribute("data-streaming")).toBeNull();
  expect(screen.getByText("正在回答").hasAttribute("data-streaming")).toBe(true);
  expect(bubble.parentElement).toBe(current);
  expect(current.lastElementChild).toBe(bubble);
  const card = container.querySelector("[data-approval-id]")!;
  expect(bubble.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // message_created replaces the bubble with the reply at the same place.
  const question = screen.getByText("新的问题").closest(".message-entry");
  rerender(view("", { history: [...history, message("m21", "assistant", "正在回答")], approvals: [approval] }));
  const reply = screen.getByText("正在回答").closest(".message-entry")!;
  expect(reply.parentElement).toBe(current);
  expect(reply.previousElementSibling).toBe(question);
  expect(screen.getByText("正在回答").hasAttribute("data-streaming")).toBe(false);
});

it("shows a stream before the first recorded turn", () => {
  const { container } = render(view("第一句", { history: [] }));
  expect(container.querySelector(".timeline-turn")).toBeNull();
  expect(screen.getByText("第一句").closest(".timeline-inner")).toBeTruthy();
});
