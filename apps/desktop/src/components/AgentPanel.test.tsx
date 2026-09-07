// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { AgentPanel } from "./AgentPanel";

afterEach(cleanup);
const agent = {
  agentId: "a-child",
  name: "A child",
  description: "A only",
  status: "completed",
  createdAt: "2026-09-07T00:00:00Z",
};

it("clears children and results when the session changes, without relying on a parent key", async () => {
  let resolveOutput!: (value: unknown) => void;
  const call = vi.fn((method, params) =>
    method === "agent.output"
      ? new Promise((resolve) => {
          resolveOutput = resolve;
        })
      : Promise.resolve({ agents: params.sessionId === "a" ? [agent] : [] })
  );
  const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
  const view = render(
    <AgentPanel client={client} sessionId="a" busy={false} />
  );
  await screen.findByRole("button", { name: /子任务/ });
  fireEvent.click(screen.getByRole("button", { name: /子任务/ }));
  fireEvent.click(screen.getByRole("button", { name: /A child/ }));
  view.rerender(<AgentPanel client={client} sessionId="b" busy={false} />);
  expect(screen.queryByText("A child")).toBeNull();
  expect(screen.queryByText("正在读取子任务")).toBeNull();
  await act(async () =>
    resolveOutput({ ...agent, result: "private A result" })
  );
  expect(screen.queryByText("private A result")).toBeNull();
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("agent.list", { sessionId: "b" })
  );
});

it("does not retain an old session's list error", async () => {
  const call = vi.fn((_method, params) =>
    params.sessionId === "a"
      ? Promise.reject(new Error("A list failed"))
      : Promise.resolve({ agents: [] })
  );
  const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
  const view = render(
    <AgentPanel client={client} sessionId="a" busy={false} />
  );
  await screen.findByRole("alert");
  view.rerender(<AgentPanel client={client} sessionId="b" busy={false} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
