// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message, ToolCall } from "../types";
import { Timeline, type TimelineProps } from "./Timeline";

vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <p data-markdown="">{children}</p> }));
afterEach(cleanup);
const noop = () => undefined;
const at = (n: number) => `2026-10-14T00:00:0${n}Z`;
const user: Message = { id: "u", sessionId: "s", role: "user", content: "完成验证", createdAt: at(0) };
const interim: Message = { id: "i", sessionId: "s", role: "assistant", assistantKind: "interim",
  content: "尚未复核的结论 [报告](/w/draft.pdf)", reasoning: "复核前的思考", createdAt: at(1) };
const final: Message = { ...interim, id: "f", assistantKind: "final", content: "已经完成最终验证", reasoning: undefined, createdAt: at(4) };
const props: TimelineProps = { messages: [user], toolCalls: [], approvals: [], questions: [], plan: [], artifacts: [], queue: [],
  streamingText: "", turnProgress: null, busy: true, workspacePath: "/w",
  onResolveApproval: noop, onResolveQuestion: noop, onRollback: noop, onOpenFile: noop, onOpenUrl: noop,
  onSteerQueued: async () => undefined, onRemoveQueued: async () => undefined, onUpdateQueued: async () => undefined,
  onRewrite: async () => true, onError: noop };
const anchor = () => document.querySelector('[data-history-anchor="message:i"]')!;
const expectNoDelivery = () => {
  expect(anchor().querySelector(".message-footer, .artifact-card")).toBeNull();
  expect(anchor().classList.contains("is-final")).toBe(false);
};

it("transitions from busy through interim and continued tools to a normal final reply", async () => {
  const view = render(<Timeline {...props} streamingText="正在生成候选结论" />);
  expect(screen.getByText("正在生成候选结论")).toBeTruthy();
  view.rerender(<Timeline {...props} messages={[user, interim]} />);
  const toggle = screen.getByRole("button", { name: "仍在继续验证 · 中间结果" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(anchor().querySelector("[data-markdown], .deep-thinking")).toBeNull();
  expect(screen.queryByText(interim.content)).toBeNull();
  expectNoDelivery();
  fireEvent.click(toggle);
  expect(screen.getByText(interim.content)).toBeTruthy();
  expectNoDelivery();
  fireEvent.click(toggle);
  expect(screen.queryByText(interim.content)).toBeNull();
  const continuation: ToolCall = { id: "t", sessionId: "s", toolName: "file_read", input: { path: "result.txt" },
    status: "running", createdAt: at(2) };
  view.rerender(<Timeline {...props} messages={[user, interim]} toolCalls={[continuation]} />);
  expect(screen.getByRole("button", { name: "仍在继续验证 · 中间结果" })).toBeTruthy();
  expect(screen.queryByText(interim.content)).toBeNull();
  view.rerender(<Timeline {...props} messages={[user, interim, final]} toolCalls={[{ ...continuation, status: "succeeded" }]}
    busy={false} latestTurnTiming={{ messageId: user.id, timing: { startedAt: at(0), status: "completed" } }} />);
  expect(screen.getByRole("button", { name: "中间结果（已继续执行）" })).toBeTruthy();
  expect(anchor().closest(".completed-process")).toBeNull();
  expectNoDelivery();
  expect(screen.getByText(final.content).closest(".is-final")?.querySelector(".message-footer")).toBeTruthy();
  expect(screen.queryByText(interim.content)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "中间结果（已继续执行）" }));
  expect(screen.getByText(interim.content)).toBeTruthy();
  expectNoDelivery();
  await waitFor(() => expect(screen.queryByLabelText("本轮尚未结束")).toBeNull());
});

it.each(["completed", "failed", "cancelled"] as const)("restores persisted %s history without promoting interim to final", (status) => {
  const restored: Message[] = JSON.parse(JSON.stringify([
    { ...user, turnTiming: { startedAt: at(0), status } }, interim,
  ]));
  render(<Timeline {...props} messages={restored} busy={false}
    lastTurn={status === "failed" ? { anchorMessageId: user.id, status, error: "复核失败" } : null} />);
  expect(screen.getByRole("button", { name: "中间结果（已继续执行）" })).toBeTruthy();
  expect(screen.queryByText(interim.content)).toBeNull();
  expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
  expectNoDelivery();
  if (status === "failed") expect(screen.getByRole("alert", { name: "本轮执行失败" }).textContent).toContain("复核失败");
});

it("locates an interim search match without mounting its original text", async () => {
  render(<Timeline {...props} busy={false} messages={[user, interim, final]} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索当前会话" }), { target: { value: "尚未复核的结论" } });
  expect(screen.getByText("1 / 1")).toBeTruthy();
  expect(screen.queryByText(interim.content)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看上下文" }));
  await waitFor(() => expect(anchor().getAttribute("data-search-located")).toBe("true"));
  expect(screen.queryByText(interim.content)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "中间结果（已继续执行）" }));
  expect(screen.getByText(interim.content)).toBeTruthy();
});

it("keeps interim marked as running across inline steering but not across a new turn", () => {
  const steer: Message = { ...user, id: "steer", steered: true, content: "继续复核", createdAt: at(2) };
  const view = render(<Timeline {...props} messages={[user, interim, steer]} />);
  expect(screen.getByRole("button", { name: "仍在继续验证 · 中间结果" })).toBeTruthy();
  view.rerender(<Timeline {...props} messages={[user, interim, { ...steer, steered: false }]} />);
  expect(screen.getByRole("button", { name: "中间结果（已继续执行）" })).toBeTruthy();
  expect(screen.queryByText(interim.content)).toBeNull();
});
