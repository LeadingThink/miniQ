// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { ApprovalRulesSection } from "./ApprovalRules";

afterEach(cleanup);

const rules = [
  {
    id: "rule-1",
    tool: "demo.echo",
    binding: { origin: "plugin:demo/echo", pluginMajor: 1 },
    createdAt: "2026-09-26T08:00:00Z",
    createdBy: "local",
  },
  {
    id: "rule-2",
    tool: "file_write",
    binding: { origin: "builtin:file_write" },
    createdAt: "2026-09-26T08:00:00Z",
    createdBy: "local",
    staleReason: "descHash",
  },
];

it("lists rules, marks stale ones and revokes", async () => {
  let current = rules;
  const call = vi.fn(async (method: string, params?: { ruleId: string }) => {
    if (method === "approval.rules.revoke") {
      current = current.filter((rule) => rule.id !== params?.ruleId);
      return { revoked: true };
    }
    return { rules: current };
  });
  const client = { mode: "local", call, onEvent: () => () => {} } as unknown as RpcClient;
  render(<ApprovalRulesSection client={client} />);
  await screen.findByText("demo.echo");
  expect(screen.getByText(/已失效/)).toBeTruthy();
  fireEvent.click(screen.getAllByText("撤销")[0]);
  await waitFor(() => expect(screen.queryByText("demo.echo")).toBeNull());
  expect(call).toHaveBeenCalledWith("approval.rules.revoke", { ruleId: "rule-1" });
});

it("shows an empty state", async () => {
  const client = {
    mode: "local",
    call: vi.fn().mockResolvedValue({ rules: [] }),
    onEvent: () => () => {},
  } as unknown as RpcClient;
  render(<ApprovalRulesSection client={client} />);
  await screen.findByText("暂无规则");
});
