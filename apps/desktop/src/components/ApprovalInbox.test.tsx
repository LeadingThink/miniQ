// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { ApprovalInbox } from "./ApprovalInbox";

afterEach(cleanup);
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
const entry = {
  approval: {
    id: "approval-1",
    sessionId: "session-1",
    toolCallId: "tool-1",
    riskLevel: "high",
    status: "pending",
    reason: "review first",
    createdAt: "2026-09-09T00:00:00Z",
    resolvedAt: null,
  },
  sessionTitle: "Research",
  toolName: "shell_run",
  agentId: "child-1",
};
const client = (call: ReturnType<typeof vi.fn>) =>
  ({
    call,
    onStatus: () => () => {},
    onEvent: () => () => {},
  }) as unknown as RpcClient;

it("loads metadata first, fetches parameters on expansion, and prevents duplicate decisions", async () => {
  let resolved = false;
  let finish!: () => void;
  const call = vi.fn(async (method: string) => {
    if (method === "tool.detail")
      return { sessionId: "session-1", input: { command: "complete command" } };
    if (method === "approval.resolve") {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      resolved = true;
      return { resolved: true };
    }
    return { entries: resolved ? [] : [entry], nextCursor: null };
  });
  render(
    <ApprovalInbox
      client={client(call)}
      onOpenSession={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByText("shell_run · review first"));
  await screen.findByText(/complete command/);
  expect(call.mock.calls.map(([method]) => method)).toEqual([
    "approval.inbox",
    "tool.detail",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
  fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
  expect(
    call.mock.calls.filter(([method]) => method === "approval.resolve"),
  ).toHaveLength(1);
  finish();
  await screen.findByText("没有待审批的操作");
});

it("opens the owning session and closes the inbox", async () => {
  const onOpenSession = vi.fn();
  const onClose = vi.fn();
  render(
    <ApprovalInbox
      client={client(
        vi.fn().mockResolvedValue({ entries: [entry], nextCursor: null }),
      )}
      onOpenSession={onOpenSession}
      onClose={onClose}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Research" }));
  expect(onOpenSession).toHaveBeenCalledWith("session-1");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("shows loading errors and retries without approving anything", async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ entries: [], nextCursor: null });
  render(
    <ApprovalInbox
      client={client(call)}
      onOpenSession={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "刷新待审批" }));
  await screen.findByText("没有待审批的操作");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(call.mock.calls.every(([method]) => method === "approval.inbox")).toBe(
    true,
  );
});
