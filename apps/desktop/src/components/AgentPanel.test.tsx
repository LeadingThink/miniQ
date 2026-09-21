// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { AgentPanel } from "./AgentPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
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
  expect(screen.getByLabelText("子任务状态：0 个执行中，1 个已完成，1 个异常")).toBeTruthy();
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
  expect(screen.getByText(/至少 1 秒/)).toBeTruthy();
  expect(await screen.findByText(/preserved instruction/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "停止 A child" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "查看 A child 模型调用" }),
  ).toBeTruthy();
});

it("keeps truthful status counts, segments and phases visible while collapsed", async () => {
  const call = vi.fn().mockResolvedValue({
    agents: [
      agent,
      { ...agent, agentId: "running", status: "running", progress: {
        phase: "receiving_model", modelStep: 7, startedAt: "2026-09-21T00:00:00Z",
      } },
      { ...agent, agentId: "failed", status: "failed" },
      { ...agent, agentId: "interrupted", status: "interrupted" },
      { ...agent, agentId: "cancelled", status: "cancelled" },
    ],
  });
  render(<AgentPanel client={{ call, onStatus: () => () => {} } as unknown as RpcClient} sessionId="a" busy={false} />);
  const toggle = await screen.findByRole("button", { name: /子任务.*总计/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByLabelText("子任务状态：1 个执行中，1 个已完成，2 个异常")).toBeTruthy();
  expect(screen.getByRole("img", { name: "状态分段：执行中 1，已完成 1，异常 2，其他 1" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("阶段：接收响应 · 第 7 轮");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("A child")).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText("模型正在生成响应 · 第 7 轮")).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.getByLabelText("子任务状态：1 个执行中，1 个已完成，2 个异常")).toBeTruthy();
});

describe("recoverable agent refresh", () => {
  it("recovers automatically when the very first list request fails", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValueOnce(new Error("temporary disconnect"))
      .mockResolvedValue({ agents: [agent] });
    render(<AgentPanel client={{ call, onStatus: () => () => {} } as unknown as RpcClient} sessionId="a" busy={false} />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("将自动重试");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(call).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("子任务状态：0 个执行中，1 个已完成，0 个异常")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("refreshes immediately on returning to the foreground", async () => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const call = vi.fn().mockResolvedValue({ agents: [agent] });
    try {
      render(<AgentPanel client={{ call, onStatus: () => () => {} } as unknown as RpcClient} sessionId="a" busy={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(call).not.toHaveBeenCalled();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(call).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: /子任务.*总计/ })).toBeTruthy();
    } finally {
      if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("coalesces reconnects during an in-flight request without dropping the refresh", async () => {
    vi.useFakeTimers();
    let resolveList!: (value: unknown) => void;
    let status!: (connected: boolean) => void;
    const call = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }))
      .mockResolvedValue({ agents: [{ ...agent, status: "failed" }] });
    const client = { call, onStatus: (listener: typeof status) => { status = listener; return () => {}; } } as unknown as RpcClient;
    render(<AgentPanel client={client} sessionId="a" busy={false} />);
    await act(async () => { status(true); status(true); });
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => { resolveList({ agents: [agent] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(call).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("子任务状态：0 个执行中，0 个已完成，1 个异常")).toBeTruthy();
  });

  it("ignores a previous session's late list response and cancels its retry timer", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    const call = vi.fn((_method, params) => params.sessionId === "a"
      ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ agents: [] }));
    const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
    const view = render(<AgentPanel client={client} sessionId="a" busy />);
    view.rerender(<AgentPanel client={client} sessionId="b" busy={false} />);
    await act(async () => { resolveOld({ agents: [agent] }); await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByRole("region", { name: "子任务" })).toBeNull();
    expect(call).toHaveBeenCalledTimes(2);
  });
});
