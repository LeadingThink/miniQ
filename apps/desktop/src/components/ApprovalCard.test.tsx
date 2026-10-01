// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingApproval } from "../App";
import type { RpcClient } from "../rpc";
import { SessionFileAccess } from "../sessionFileAccess";
import { ApprovalCard } from "./TimelineInteractions";

afterEach(cleanup);

const item = {
  approval: {
    id: "approval-1",
    sessionId: "session-1",
    toolCallId: "tool-1",
    riskLevel: "medium",
    status: "pending",
    reason: "third-party WASM plugin",
    createdAt: "2026-09-03T01:00:02Z",
  },
  toolName: "demo.echo",
  input: {},
} as PendingApproval;

function renderCard(mode: "local" | "remote") {
  const onResolve = vi.fn();
  const client = { mode } as unknown as RpcClient;
  render(
    <SessionFileAccess client={client} sessionId="session-1">
      <ApprovalCard item={item} onResolve={onResolve} />
    </SessionFileAccess>,
  );
  return onResolve;
}

it("offers always-allow on the desktop host", () => {
  const onResolve = renderCard("local");
  fireEvent.click(screen.getByText("总是允许"));
  expect(onResolve).toHaveBeenCalledWith("approval-1", "always_allow_tool");
});

it("hides always-allow for remote clients", () => {
  renderCard("remote");
  expect(screen.queryByText("总是允许")).toBeNull();
  expect(screen.getByText("本会话允许")).toBeTruthy();
});
