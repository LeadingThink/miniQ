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

it("filters agents by status and model without losing the original list", async () => {
  const call = vi.fn().mockResolvedValue({
    agents: [
      agent,
      {
        ...agent,
        agentId: "b",
        name: "Reviewer",
        status: "failed",
        model: "claude",
      },
    ],
  });
  render(
    <AgentPanel
      client={{ call, onStatus: () => () => {} } as unknown as RpcClient}
      sessionId="a"
      busy={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /子任务.*总计/ }));
  fireEvent.click(screen.getByRole("button", { name: "异常" }));
  expect(screen.queryByText("A child")).toBeNull();
  expect(screen.getByText("Reviewer")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索子任务" }), {
    target: { value: "GPT" },
  });
  expect(screen.getByText("没有匹配的子任务")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索子任务" }), {
    target: { value: "CLAUDE" },
  });
  expect(screen.getByText("Reviewer")).toBeTruthy();
});

it("refreshes a selected result and keeps a result error separate from the list", async () => {
  let attempts = 0;
  const call = vi.fn((method) =>
    method === "agent.list"
      ? Promise.resolve({ agents: [agent] })
      : ++attempts === 1
        ? Promise.reject(new Error("result offline"))
        : Promise.resolve({ ...agent, result: "fresh output" }),
  );
  render(
    <AgentPanel
      client={{ call, onStatus: () => () => {} } as unknown as RpcClient}
      sessionId="a"
      busy={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /子任务.*总计/ }));
  fireEvent.click(screen.getByRole("button", { name: /^A child/ }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "刷新子任务" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新 A child 结果" }));
  expect(await screen.findByText("fresh output")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clears children and results when the session changes, without relying on a parent key", async () => {
  let resolveOutput!: (value: unknown) => void;
  const call = vi.fn((method, params) =>
    method === "agent.output"
      ? new Promise((resolve) => {
          resolveOutput = resolve;
        })
      : Promise.resolve({ agents: params.sessionId === "a" ? [agent] : [] }),
  );
  const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
  const view = render(
    <AgentPanel client={client} sessionId="a" busy={false} />,
  );
  await screen.findByRole("button", { name: /子任务/ });
  fireEvent.click(screen.getByRole("button", { name: /子任务/ }));
  fireEvent.click(screen.getByRole("button", { name: /^A child/ }));
  view.rerender(<AgentPanel client={client} sessionId="b" busy={false} />);
  expect(screen.queryByText("A child")).toBeNull();
  expect(screen.queryByText("正在读取子任务")).toBeNull();
  await act(async () =>
    resolveOutput({ ...agent, result: "private A result" }),
  );
  expect(screen.queryByText("private A result")).toBeNull();
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("agent.list", { sessionId: "b" }),
  );
});

it("does not retain an old session's list error", async () => {
  const call = vi.fn((_method, params) =>
    params.sessionId === "a"
      ? Promise.reject(new Error("A list failed"))
      : Promise.resolve({ agents: [] }),
  );
  const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
  const view = render(
    <AgentPanel client={client} sessionId="a" busy={false} />,
  );
  await screen.findByRole("alert");
  view.rerender(<AgentPanel client={client} sessionId="b" busy={false} />);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("toggles individual results and ignores results arriving after collapse", async () => {
  let resolveOutput!: (value: unknown) => void;
  const call = vi.fn((method) =>
    method === "agent.output"
      ? new Promise((resolve) => {
          resolveOutput = resolve;
        })
      : Promise.resolve({ agents: [agent] }),
  );
  const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
  render(<AgentPanel client={client} sessionId="a" busy={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /子任务.*总计/ }));
  const child = screen.getByRole("button", { name: /^A child/ });
  fireEvent.click(child);
  expect(child.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(child);
  expect(child.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: "A child 详情" })).toBeNull();
  await act(async () => {
    resolveOutput({ ...agent, result: "late result" });
  });
  expect(screen.queryByText("late result")).toBeNull();
  fireEvent.click(child);
  await act(async () => {
    resolveOutput({ ...agent, result: "full result" });
  });
  expect(screen.getByText("full result")).toBeTruthy();
  fireEvent.click(child);
  expect(screen.queryByText("full result")).toBeNull();
  expect(
    call.mock.calls.filter(([method]) => method === "agent.output"),
  ).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /子任务.*总计/ }));
  expect(screen.queryByText("A child")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /子任务.*总计/ }));
  expect(screen.getByText("A child")).toBeTruthy();
});

it("shows retry progress for a running child and keeps its stop action available", async () => {
  const running = {
    ...agent,
    status: "running",
    progress: {
      phase: "waiting_retry",
      startedAt: new Date().toISOString(),
      modelStep: 2,
      retry: { attempt: 1, maxAttempts: 4, delayMs: 60000 },
    },
  };
  const call = vi.fn((method) =>
    Promise.resolve(
      method === "agent.stop"
        ? { ...agent, status: "cancelled" }
        : { agents: [running] },
    ),
  );
  const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
  render(<AgentPanel client={client} sessionId="a" busy={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /子任务.*总计/ }));
  expect(screen.getByText(/自动重试 1\/4/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "停止 A child" }));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("agent.stop", {
      sessionId: "a",
      agentId: agent.agentId,
    }),
  );
});

it("shows interrupted agents in the exception filter with observed time and held messages", async () => {
  const interrupted = {
    ...agent,
    status: "interrupted",
    elapsedMs: 1200,
    timingComplete: false,
    heldMessagesCount: 1,
    heldMessages: ["preserved instruction"],
  };
  const call = vi.fn((method) =>
    Promise.resolve(
      method === "agent.list" ? { agents: [interrupted] } : interrupted,
    ),
  );
  render(
    <AgentPanel
      client={{ call, onStatus: () => () => {} } as unknown as RpcClient}
      sessionId="a"
      busy={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /子任务.*总计/ }));
  fireEvent.click(screen.getByRole("button", { name: "异常" }));
  fireEvent.click(screen.getByRole("button", { name: /^A child/ }));
  expect(screen.getByText(/至少 1.2 秒/)).toBeTruthy();
  expect(await screen.findByText(/preserved instruction/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "停止 A child" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "查看 A child 模型调用" }),
  ).toBeTruthy();
});
