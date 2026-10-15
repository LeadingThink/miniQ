// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingApproval } from "../hooks/useSessionFeed";
import { PendingApprovalBar } from "./PendingApprovalBar";
import { SessionFileAccess } from "../sessionFileAccess";
import type { RpcClient } from "../rpc";

afterEach(cleanup);
const approval = (id: string, toolName = "http_request"): PendingApproval => ({
  toolName, input: { method: "GET", url: "http://127.0.0.1:5174/" },
  approval: { id, sessionId: "s", toolCallId: `t-${id}`, status: "pending", createdAt: "2026-10-14T00:00:00Z", riskLevel: "high", reason: "network request to 127.0.0.1" },
});

it("renders nothing without pending requests", () => {
  const { container } = render(<PendingApprovalBar approvals={[]} onResolve={vi.fn()} />);
  expect(container.firstChild).toBeNull();
});
it("shows one complete approval at a time and moves to remaining requests after resolution", async () => {
  const onResolve = vi.fn();
  const a = approval("a1"), b = approval("a2", "shell_run");
  const view = render(<PendingApprovalBar approvals={[a, b]} onResolve={onResolve} />);
  expect(view.container.querySelectorAll("[data-approval-id]")).toHaveLength(1);
  expect(screen.getByText("第 1 / 2 项")).toBeTruthy();
  expect(screen.getByText("network request to 127.0.0.1")).toBeTruthy();
  expect(screen.getByText("待审批参数")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "允许一次" })));
  expect(onResolve).toHaveBeenCalledWith("a1", "approve");
  fireEvent.click(screen.getByRole("button", { name: "下一项审批" }));
  expect(screen.getByText("shell_run")).toBeTruthy();
  expect(screen.getByText("第 2 / 2 项")).toBeTruthy();
  view.rerender(<PendingApprovalBar approvals={[a]} onResolve={onResolve} />);
  expect(screen.getByText("http_request")).toBeTruthy();
  expect(screen.queryByLabelText("待审批队列")).toBeNull();
});
it("blocks duplicate decisions while awaiting acknowledgement and exposes a retryable error", async () => {
  let reject!: (error: Error) => void;
  const onResolve = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  render(<PendingApprovalBar approvals={[approval("a1")]} onResolve={onResolve} />);
  const allow = screen.getByRole("button", { name: "允许一次" }) as HTMLButtonElement;
  fireEvent.click(allow);
  fireEvent.click(allow);
  expect(allow.disabled).toBe(true);
  expect(onResolve).toHaveBeenCalledOnce();
  await act(async () => reject(new Error("连接失败")));
  expect(screen.getByRole("alert").textContent).toBe("连接失败");
  expect(allow.disabled).toBe(false);
});
it("preserves remote restrictions and exposes the same decision scopes", async () => {
  const onResolve = vi.fn();
  render(<SessionFileAccess client={{ mode: "remote" } as RpcClient} sessionId="s">
    <PendingApprovalBar approvals={[approval("a1")]} onResolve={onResolve} />
  </SessionFileAccess>);
  expect(screen.queryByText("总是允许")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "本会话允许" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "拒绝" })));
  expect(onResolve.mock.calls).toEqual([["a1", "approve_for_session"], ["a1", "reject"]]);
});
