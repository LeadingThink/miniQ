// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { DaemonEvent } from "../types";
import type { ContextUsage } from "../contextUsage";
import { useContextUsage } from "./useContextUsage";

afterEach(cleanup);

const usage: ContextUsage = {
  estimatedTokens: 1_200,
  contextWindowTokens: 8_000,
  autoCompactTokens: 6_400,
  percentUsed: 15,
  lastRequestTokens: 1_100,
};

function setup(call: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(usage)) {
  const events = new Set<(event: DaemonEvent) => void>();
  const statuses = new Set<(connected: boolean) => void>();
  const resyncs = new Set<() => void>();
  const client = {
    connected: true,
    call,
    onStatus: (listener: (connected: boolean) => void) => {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
    onResync: (listener: () => void) => {
      resyncs.add(listener);
      return () => resyncs.delete(listener);
    },
    onEvent: (listener: (event: DaemonEvent) => void) => {
      events.add(listener);
      return () => events.delete(listener);
    },
  } as unknown as RpcClient;
  const hook = renderHook(({ sessionId }) => useContextUsage(client, sessionId), {
    initialProps: { sessionId: "session-a" as string | null },
  });
  return {
    ...hook,
    client,
    emit: (event: DaemonEvent) => act(() => events.forEach((listener) => listener(event))),
    status: (connected: boolean) => act(() => statuses.forEach((listener) => listener(connected))),
    resync: () => act(() => resyncs.forEach((listener) => listener())),
  };
}

it("requests session.contextUsage with the selected session id on mount", async () => {
  const call = vi.fn().mockResolvedValue(usage);
  const hook = setup(call);

  await waitFor(() => expect(hook.result.current.usage).toEqual(usage));
  expect(call).toHaveBeenCalledWith("session.contextUsage", { sessionId: "session-a" }, expect.anything());
  expect(hook.result.current.loading).toBe(false);
});

it("refreshes for matching events, global model changes, reconnect and resync, but filters unrelated events", async () => {
  const call = vi.fn().mockResolvedValue(usage);
  const hook = setup(call);
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));

  const matching: DaemonEvent[] = [
    { type: "turn_completed", sessionId: "session-a" },
    { type: "turn_failed", sessionId: "session-a", error: "failed" },
    { type: "context_compacted", sessionId: "session-a", estimatedTokensBefore: 10, estimatedTokensAfter: 5 },
    { type: "message_created", sessionId: "session-a", message: {} as never },
    { type: "model_settings_changed", sessionId: "session-a", workspaceId: "workspace-a", settings: {} as never },
    { type: "global_model_settings_changed", settings: {} as never },
  ];
  matching.forEach((event) => hook.emit(event));
  hook.emit({ type: "turn_completed", sessionId: "other" });
  hook.emit({ type: "turn_timing_changed", sessionId: "session-a", messageId: "m", timing: {} as never });
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));

  hook.status(false);
  hook.resync();
  await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
  hook.status(true);
  await waitFor(() => expect(call).toHaveBeenCalledTimes(4));
});

it("clears the previous session immediately and ignores aborted stale responses", async () => {
  let resolveA!: (value: ContextUsage) => void;
  const call = vi.fn((_method: string, params: { sessionId: string }, options: { signal: AbortSignal }) =>
    params.sessionId === "session-a"
      ? new Promise<ContextUsage>((resolve) => {
          resolveA = resolve;
          expect(options.signal).toBeInstanceOf(AbortSignal);
        })
      : Promise.resolve({ ...usage, estimatedTokens: 2_400 }),
  );
  const hook = setup(call);
  hook.rerender({ sessionId: "session-b" });
  expect(hook.result.current.usage).toBeNull();
  expect(hook.result.current.loading).toBe(true);
  await waitFor(() => expect(hook.result.current.usage?.estimatedTokens).toBe(2_400));

  await act(async () => resolveA({ ...usage, estimatedTokens: 99_999 }));
  expect(hook.result.current.usage?.estimatedTokens).toBe(2_400);
  expect(call.mock.results[0]?.value).toBeInstanceOf(Promise);
});

it("reports refresh errors and allows a later refresh to recover", async () => {
  const call = vi.fn()
    .mockRejectedValueOnce(new Error("daemon unavailable"))
    .mockResolvedValueOnce(usage);
  const hook = setup(call);
  await waitFor(() => expect(hook.result.current.error).toBe("daemon unavailable"));
  await act(async () => hook.result.current.refresh());
  expect(hook.result.current.usage).toEqual(usage);
  expect(hook.result.current.error).toBeNull();
});

it("does not request usage without a session or a connection", async () => {
  const call = vi.fn().mockResolvedValue(usage);
  const hook = setup(call);
  await waitFor(() => expect(hook.result.current.usage).toEqual(usage));
  hook.rerender({ sessionId: null });
  expect(hook.result.current.usage).toBeNull();
  await act(async () => hook.result.current.refresh());
  expect(call).toHaveBeenCalledTimes(1);
  Object.defineProperty(hook.client, "connected", { value: false });
  hook.rerender({ sessionId: "session-b" });
  await waitFor(() => expect(hook.result.current.error).toBe("连接已断开"));
  expect(call).toHaveBeenCalledTimes(1);
});

it("aborts in-flight requests on disconnect and unmount", async () => {
  const signals: AbortSignal[] = [];
  const call = vi.fn((_method, _params, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return new Promise<ContextUsage>(() => {});
  });
  const hook = setup(call);
  hook.status(false);
  expect(signals[0].aborted).toBe(true);
  expect(hook.result.current.error).toBe("连接已断开");
  hook.status(true);
  expect(signals[1].aborted).toBe(false);
  hook.unmount();
  expect(signals[1].aborted).toBe(true);
  hook.emit({ type: "turn_completed", sessionId: "session-a" });
  expect(call).toHaveBeenCalledTimes(2);
});
