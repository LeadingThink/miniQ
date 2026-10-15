// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Timeline } from "./Timeline";
import type { Message, ToolCall } from "../types";

vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <p>{children}</p> }));
afterEach(cleanup);
const noop = () => undefined;
const asyncNoop = async () => undefined;
const at = (n: number) => `2026-10-14T00:00:0${n}Z`;
const messages: Message[] = [
  { id: "u", sessionId: "s", role: "user", content: "检查文件", createdAt: at(0) },
  { id: "c1", sessionId: "s", role: "assistant", assistantKind: "commentary", content: "先读取配置", createdAt: at(1) },
  { id: "c2", sessionId: "s", role: "assistant", assistantKind: "commentary", content: "配置已确认，接着测试", createdAt: at(3) },
];
const calls: ToolCall[] = [
  { id: "t1", sessionId: "s", toolName: "file_read", input: { path: "settings.json" }, status: "succeeded", createdAt: at(2) },
  { id: "t2", sessionId: "s", toolName: "shell_run", input: { command: "npm test" }, status: "running", createdAt: at(4) },
];
const props = { messages, toolCalls: calls, busy: true, approvals: [], questions: [], plan: [], artifacts: [], queue: [],
  streamingText: "", turnProgress: { phase: "requesting_model" as const, startedAt: at(0) },
  onResolveApproval: noop, onResolveQuestion: noop, onRollback: noop, onOpenFile: noop, onOpenUrl: noop,
  onSteerQueued: asyncNoop, onRemoveQueued: asyncNoop, onUpdateQueued: asyncNoop, onRewrite: async () => true, onError: noop };

it("keeps status, commentary and each tool in order and shows actions only after final settlement", () => {
  const view = render(<Timeline {...props} />);
  const order = () => [...view.container.querySelectorAll(".timeline-turn *")]
    .filter(node => node.hasAttribute("data-history-anchor") || node.getAttribute("aria-label") === "当前任务状态")
    .map(node => node.getAttribute("data-history-anchor") ?? "status");
  expect(order()).toEqual(["message:u", "status", "message:c1", "tool:t1", "message:c2", "tool:t2"]);
  const status = screen.getByLabelText("当前任务状态");
  expect(status.closest(".timeline-turn")).toBeTruthy();
  expect(status.textContent).toContain("Working");
  expect(view.container.querySelectorAll(".assistant .message-footer")).toHaveLength(0);
  expect(view.container.querySelector("[data-execution-fold]")).toBeNull();
  expect(view.container.querySelector(".tool-group-toggle")).toBeNull();
  const finished: Message[] = [...messages, { id: "f", sessionId: "s", role: "assistant", assistantKind: "final", content: "检查完成", createdAt: at(5) }];
  view.rerender(<Timeline {...props} messages={finished} />);
  expect(view.container.querySelectorAll(".assistant .message-footer")).toHaveLength(0);
  view.rerender(<Timeline {...props} messages={finished} busy={false}
    latestTurnTiming={{ messageId: "u", timing: { startedAt: at(0), status: "completed", elapsedMs: 98000 } }} />);
  const process = view.container.querySelector<HTMLDetailsElement>(".completed-process")!;
  expect(process.open).toBe(false);
  expect(process.querySelector("summary")?.textContent).toBe("已工作 1分38秒");
  expect(view.container.querySelector('[data-history-anchor="message:c1"]')?.closest("details")).toBe(process);
  expect(view.container.querySelector('[data-history-anchor="message:f"]')?.closest(".completed-process")).toBeNull();
  process.open = true;
  expect(screen.getByText("先读取配置")).toBeTruthy();
  process.open = false;
  expect(view.container.querySelectorAll(".assistant .message-footer")).toHaveLength(1);
  expect(view.container.querySelector('[data-history-anchor="message:c1"] .message-footer')).toBeNull();
  expect(view.container.querySelector('[data-history-anchor="message:f"] .message-footer')).toBeTruthy();
  expect(order()).toEqual(["message:u", "message:c1", "tool:t1", "message:c2", "tool:t2", "message:f"]);
});

it("keeps a distinct animated tail after content until settlement", () => {
  const view = render(<Timeline {...props} toolCalls={[]} />);
  const original = screen.getByLabelText("当前任务状态");
  const check = () => {
    expect(screen.getAllByLabelText("当前任务状态")).toHaveLength(1);
    expect(screen.getByLabelText("当前任务状态")).toBe(original);
    const tail = screen.getByLabelText("本轮尚未结束");
    expect(tail.parentElement?.lastElementChild).toBe(tail);
    expect(tail.querySelector("button")).toBeNull();
    expect(original.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  };
  check();
  view.rerender(<Timeline {...props} streamingText="正在输出" />); check();
  expect(screen.getByLabelText("本轮尚未结束").previousElementSibling).toBe(screen.getByText("正在输出").closest(".message-entry"));
  view.rerender(<Timeline {...props} toolCalls={calls.map(call => ({ ...call, status: "succeeded" }))} />); check();
  view.rerender(<Timeline {...props} turnProgress={{ phase: "waiting_retry", startedAt: at(0), retry: { attempt: 1, maxAttempts: 10, delayMs: 1000 } }} />); check();
  expect(screen.getByLabelText("本轮尚未结束").textContent).toContain("Retrying");
  view.rerender(<Timeline {...props} turnProgress={{ phase: "finalizing", startedAt: at(5) }} />); check();
  expect(screen.getByLabelText("本轮尚未结束").textContent).toContain("Finishing");
  view.rerender(<Timeline {...props} questions={[{ id: "q", toolCallId: "ask", sessionId: "s", prompt: "继续吗？", options: [], createdAt: at(5) }]} />);
  expect(screen.queryByLabelText("本轮尚未结束")).toBeNull();
  for (const status of ["completed", "failed", "cancelled"] as const) {
    view.rerender(<Timeline {...props} busy={false} latestTurnTiming={{ messageId: "u", timing: { startedAt: at(0), status } }} />);
    expect(screen.queryByLabelText("当前任务状态")).toBeNull();
    expect(screen.queryByLabelText("本轮尚未结束")).toBeNull();
  }
});

it("shows a tail before the first token and keeps it after the final message until the turn ends", () => {
  const view = render(<Timeline {...props} messages={[messages[0]]} toolCalls={[]} />);
  expect(screen.getByLabelText("本轮尚未结束").textContent).toContain("Thinking");
  const final: Message = { id: "answer", sessionId: "s", role: "assistant", assistantKind: "final", content: "答案已输出", createdAt: at(5) };
  view.rerender(<Timeline {...props} messages={[messages[0], final]} toolCalls={[]} />);
  expect(screen.getByLabelText("本轮尚未结束").previousElementSibling).toBe(screen.getByText("答案已输出").closest(".message-entry"));
  expect(view.container.querySelector(".assistant .message-footer")).toBeNull();
  view.rerender(<Timeline {...props} messages={[messages[0], final]} toolCalls={[]} busy={false} />);
  expect(screen.queryByLabelText("本轮尚未结束")).toBeNull();
  expect(view.container.querySelector(".assistant .message-footer")).toBeTruthy();
});

it("uses the daemon turn clock at the tail even when history is paged out", () => {
  const startedAt = new Date(Date.now() - 83_000).toISOString();
  const view = render(<Timeline {...props} messages={[]} toolCalls={[]}
    turnProgress={{ phase: "requesting_model", startedAt }} />);
  expect(screen.getByLabelText("本轮尚未结束").textContent).toContain("（已运行 1分23秒）");
  view.rerender(<Timeline {...props} messages={[]} toolCalls={[]} busy={false} />);
  expect(screen.queryByLabelText("本轮尚未结束")).toBeNull();
});

it("collapses only contiguous activity, keeping commentary outside and searchable call keys intact", () => {
  const extra: ToolCall = { ...calls[0], id: "t-extra", toolName: "file_grep", input: { pattern: "config" }, createdAt: "2026-10-14T00:00:02.500Z" };
  const view = render(<Timeline {...props} toolCalls={[calls[0], extra, calls[1]]} />);
  expect(view.container.querySelectorAll(".tool-run")).toHaveLength(1);
  expect(screen.getByText("配置已确认，接着测试").closest(".tool-run")).toBeNull();
  const group = view.container.querySelector('[data-search-records="tool:t1 tool:t-extra"]');
  expect(group).toBeTruthy();
  expect(view.container.querySelector('[data-history-anchor="tool:t-extra"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /已探索/ }));
  expect(view.container.querySelector('[data-history-anchor="tool:t-extra"]')).toBeTruthy();
});

it("has one approval decision surface outside history, with no duplicate Working notice", async () => {
  const onResolveApproval = vi.fn();
  const approval = { toolName: "shell_run", input: { command: "npm test" }, approval: {
    id: "approve-test", sessionId: "s", toolCallId: "t2", riskLevel: "medium" as const,
    status: "pending" as const, reason: "执行命令需要确认", createdAt: at(4),
  } };
  const view = render(<Timeline {...props} approvals={[approval]} onResolveApproval={onResolveApproval} />);
  expect(view.container.querySelectorAll("[data-approval-id]")).toHaveLength(1);
  expect(view.container.querySelector(".timeline [data-approval-id]")).toBeNull();
  expect(screen.queryByLabelText("当前任务状态")).toBeNull();
  expect(screen.queryByLabelText("本轮尚未结束")).toBeNull();
  expect(screen.getAllByRole("button", { name: "允许一次" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
  expect(onResolveApproval).toHaveBeenCalledWith("approve-test", "approve");
  view.rerender(<Timeline {...props} approvals={[]} onResolveApproval={onResolveApproval} />);
  expect(screen.queryByLabelText("待审批操作")).toBeNull();
  expect(screen.getByLabelText("当前任务状态")).toBeTruthy();
});

it("does not invent durations for old turns, and leaves interrupted output visible", () => {
  const interrupted: Message = { ...messages[1], assistantKind: "interrupted" };
  const { container } = render(<Timeline {...props} busy={false} messages={[messages[0], interrupted]} />);
  expect(container.querySelectorAll(".assistant .message-footer")).toHaveLength(0);
  expect(container.querySelector(".completed-process > summary")?.textContent).toBe("工作过程");
  expect(screen.getByText("先读取配置").closest(".completed-process")).toBeNull();
});
