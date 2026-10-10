// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message, ToolCall } from "../types";
import { groupTimelineTurns } from "../timelineTurns";
import { createTimelineItems, groupTimeline } from "../timelineModel";

vi.mock("./Md", () => ({
  Md: (props: { children: string }) => <div>{props.children}</div>,
}));

const { Timeline } = await import("./Timeline");

afterEach(cleanup);

const noop = () => undefined;
const asyncNoop = async () => undefined;
const none: never[] = [];

function message(id: string, role: Message["role"], minute: number, extra: Partial<Message> = {}): Message {
  return { id, sessionId: "s", role, content: `${role} ${id}`, createdAt: `2026-01-01T00:0${minute}:00Z`, ...extra };
}

const tool = (id: string, minute: number): ToolCall => ({
  id, sessionId: "s", toolName: "shell", input: {}, output: "ok", status: "succeeded",
  createdAt: `2026-01-01T00:0${minute}:30Z`, completedAt: `2026-01-01T00:0${minute}:40Z`,
});

const steeredMessages = [
  message("u1", "user", 1),
  message("u2", "user", 3, { content: "改用 pnpm", steered: true }),
  message("a2", "assistant", 5),
];
const steeredTools = [tool("t1", 2), tool("t2", 4)];

function view(props: { busy: boolean; messages: Message[]; toolCalls?: ToolCall[]; onRewrite?: () => Promise<boolean>; onStopTurn?: () => Promise<void> }) {
  return (
    <Timeline
      messages={props.messages}
      toolCalls={props.toolCalls ?? none}
      approvals={none}
      questions={none}
      plan={none}
      artifacts={none}
      queue={none}
      streamingText=""
      turnProgress={null}
      busy={props.busy}
      onResolveApproval={noop}
      onResolveQuestion={noop}
      onRollback={noop}
      onOpenFile={noop}
      onOpenUrl={noop}
      onSteerQueued={asyncNoop}
      onRemoveQueued={asyncNoop}
      onUpdateQueued={asyncNoop}
      onRewrite={props.onRewrite ?? (async () => true)}
      onStopTurn={props.onStopTurn}
      onError={noop}
    />
  );
}

it("keeps a steered message inside the turn it interrupted", () => {
  const groups = groupTimeline(createTimelineItems(steeredMessages, steeredTools));
  const turns = groupTimelineTurns(groups);
  expect(turns).toHaveLength(1);
  expect(turns[0].userMessageId).toBe("u1");
});

it("renders a steered message as an inline steer note in the process flow", () => {
  const { container } = render(view({ busy: false, messages: steeredMessages, toolCalls: steeredTools }));
  expect(container.querySelectorAll(".timeline-turn")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /已执行/ }));
  const note = container.querySelector(".steer-note");
  expect(note?.textContent).toBe("引导：改用 pnpm");
  expect(container.querySelector('[data-user-message-id="u2"]')).toBeNull();
});

const plainMessages = [message("u1", "user", 1), message("a1", "assistant", 2)];

it("confirms, stops the running turn, then rewrites an edited message", async () => {
  const order: string[] = [];
  const onStopTurn = vi.fn(async () => { order.push("stop"); });
  const onRewrite = vi.fn(async () => { order.push("rewrite"); return true; });
  render(view({ busy: true, messages: plainMessages, onRewrite, onStopTurn }));
  const edit = screen.getByRole("button", { name: "修改消息" }) as HTMLButtonElement;
  expect(edit.disabled).toBe(false);
  fireEvent.click(edit);
  fireEvent.change(screen.getByLabelText("修改消息内容"), { target: { value: "new question" } });
  fireEvent.click(screen.getByRole("button", { name: "发送修改" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(onStopTurn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "停止并继续" }));
  await waitFor(() => expect(order).toEqual(["stop", "rewrite"]));
  expect(onRewrite).toHaveBeenCalledWith("u1", "new question", undefined);
});

it("cancelling the confirmation neither stops nor rewrites", () => {
  const onStopTurn = vi.fn(asyncNoop);
  const onRewrite = vi.fn(async () => true);
  render(view({ busy: true, messages: plainMessages, onRewrite, onStopTurn }));
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onStopTurn).not.toHaveBeenCalled();
  expect(onRewrite).not.toHaveBeenCalled();
});

it("regenerates the latest reply while running after stopping the turn", async () => {
  const order: string[] = [];
  render(view({
    busy: true,
    messages: plainMessages,
    onStopTurn: async () => { order.push("stop"); },
    onRewrite: async () => { order.push("rewrite"); return true; },
  }));
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  fireEvent.click(screen.getByRole("button", { name: "停止并继续" }));
  await waitFor(() => expect(order).toEqual(["stop", "rewrite"]));
});

it("rewrites immediately without confirmation when idle", async () => {
  const onStopTurn = vi.fn(asyncNoop);
  const onRewrite = vi.fn(async () => true);
  render(view({ busy: false, messages: plainMessages, onRewrite, onStopTurn }));
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  await waitFor(() => expect(onRewrite).toHaveBeenCalledWith("u1", "user u1", undefined));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(onStopTurn).not.toHaveBeenCalled();
});
