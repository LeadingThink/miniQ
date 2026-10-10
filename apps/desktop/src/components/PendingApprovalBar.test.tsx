// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingApproval } from "../hooks/useSessionFeed";
import { PendingApprovalBar } from "./PendingApprovalBar";

afterEach(cleanup);

const approval = (id: string, toolName: string): PendingApproval => ({
  toolName,
  input: { method: "GET", url: "http://127.0.0.1:5174/" },
  approval: { id, riskLevel: "high", reason: "network request to 127.0.0.1" },
}) as unknown as PendingApproval;

it("renders nothing without a pending approval", () => {
  const { container } = render(<PendingApprovalBar approvals={[]} onResolve={vi.fn()} onShowDetails={vi.fn()} />);
  expect(container.firstChild).toBeNull();
});

it("pins the first approval with its decisions and the remaining count", () => {
  const onResolve = vi.fn(), onShowDetails = vi.fn();
  render(<PendingApprovalBar approvals={[approval("a1", "http_request"), approval("a2", "shell_run")]}
    onResolve={onResolve} onShowDetails={onShowDetails} />);
  const bar = screen.getByRole("region", { name: "待审批操作" });
  expect(bar.textContent).toContain("http_request");
  expect(bar.textContent).toContain("network request to 127.0.0.1");
  expect(bar.textContent).toContain("还有 1 项");
  fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
  fireEvent.click(screen.getByRole("button", { name: "本会话允许" }));
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  expect(onResolve.mock.calls).toEqual([["a1", "approve"], ["a1", "approve_for_session"], ["a1", "reject"]]);
  fireEvent.click(screen.getByRole("button", { name: "查看参数" }));
  expect(onShowDetails).toHaveBeenCalledWith("a1");
});
