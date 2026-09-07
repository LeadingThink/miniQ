// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { DaemonEvent } from "../types";
import { useSessionFeed, type LoadedSessionFeed } from "./useSessionFeed";
import { useSessionError } from "./useSessionError";

afterEach(cleanup);

const snapshot: LoadedSessionFeed = {
  messages: [
    {
      id: "m-a",
      sessionId: "a",
      role: "user",
      content: "only a",
      createdAt: "2026-09-07",
    },
  ],
  toolCalls: [
    {
      id: "tool-a",
      sessionId: "a",
      toolName: "agent_run",
      input: {},
      status: "running",
      createdAt: "2026-09-07",
    },
  ],
  plan: [{ content: "a plan", status: "in_progress" }],
  artifacts: [],
  approvals: [],
  questions: [],
  queue: [],
  streamingText: "a streaming",
  turnProgress: null,
};

function setup() {
  const listeners = new Set<(event: DaemonEvent) => void>();
  const client = {
    onEvent: (listener: (event: DaemonEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RpcClient;
  const onError = vi.fn();
  const onSessionCompleted = vi.fn();
  const hook = renderHook(
    ({ id }: { id: string | null }) =>
      useSessionFeed({
        client,
        currentSessionId: id,
        onError,
        onSessionCompleted,
        refreshSessions: vi.fn(),
        onSessionStatusChanged: vi.fn(),
      }),
    { initialProps: { id: "a" as string | null } }
  );
  return {
    ...hook,
    onError,
    onSessionCompleted,
    emit: (event: DaemonEvent) =>
      act(() => listeners.forEach((listener) => listener(event))),
  };
}

it("a new session immediately has no prior messages, tasks or streaming text", () => {
  const hook = setup();
  act(() => hook.result.current.load("a", snapshot));
  expect(hook.result.current.toolCalls).toHaveLength(1);
  hook.rerender({ id: null });
  expect(hook.result.current.messages).toEqual([]);
  expect(hook.result.current.toolCalls).toEqual([]);
  expect(hook.result.current.plan).toEqual([]);
  expect(hook.result.current.streamingText).toBe("");
});

it("late snapshots and events cannot put session A tasks into B", () => {
  const hook = setup();
  const load = hook.result.current.load;
  hook.rerender({ id: "b" });
  hook.emit({
    type: "assistant_delta",
    sessionId: "b",
    messageId: "b-stream",
    delta: "b live",
  });
  act(() => load("a", snapshot));
  hook.emit({ type: "plan_updated", sessionId: "a", tasks: snapshot.plan });
  expect(hook.result.current.streamingText).toBe("b live");
  expect(hook.result.current.plan).toEqual([]);
  expect(hook.result.current.toolCalls).toEqual([]);
});

it("background failures keep their original session identity", () => {
  const hook = setup();
  hook.rerender({ id: "b" });
  hook.emit({ type: "turn_failed", sessionId: "a", error: "a failed" });
  expect(hook.onError).toHaveBeenCalledWith("a", "a failed");
  expect(hook.onSessionCompleted).toHaveBeenCalledWith("a");
  expect(hook.result.current.streamingText).toBe("");
});

it("retry replaces only interrupted output and remains isolated across sessions and reloads", () => {
  const hook = setup();
  act(() => hook.result.current.load("a", snapshot));
  hook.emit({ type: "assistant_replaced", sessionId: "b", messageId: "b-stream", text: "other" });
  expect(hook.result.current.streamingText).toBe("a streaming");
  hook.emit({ type: "assistant_replaced", sessionId: "a", messageId: "a-stream", text: "committed" });
  hook.emit({ type: "assistant_delta", sessionId: "a", messageId: "a-stream", delta: "\n\nrecovered" });
  expect(hook.result.current.streamingText).toBe("committed\n\nrecovered");
  expect(hook.result.current.toolCalls).toEqual(snapshot.toolCalls);
  expect(hook.result.current.messages).toEqual(snapshot.messages);
  act(() => hook.result.current.load("a", { ...snapshot, streamingText: "committed\n\nrecovered" }));
  expect(hook.result.current.streamingText).toBe("committed\n\nrecovered");
});

it("unrecognized wire events cannot corrupt the current feed", () => {
  const hook = setup();
  act(() => hook.result.current.load("a", snapshot));
  hook.emit({ type: "future_event", sessionId: "a" } as unknown as DaemonEvent);
  expect(hook.result.current.streamingText).toBe(snapshot.streamingText);
  expect(hook.result.current.messages).toEqual(snapshot.messages);
});

it("late action failures stay in their originating session, including drafts", () => {
  const hook = renderHook(({ id }) => useSessionError(id), {
    initialProps: { id: "a" },
  });
  const failA = hook.result.current[1];
  hook.rerender({ id: "b" });
  act(() => failA("a failed after navigation"));
  expect(hook.result.current[0]).toBeNull();
  act(() => hook.result.current[1]("b failed"));
  hook.rerender({ id: "draft:workspace" });
  expect(hook.result.current[0]).toBeNull();
  hook.rerender({ id: "a" });
  expect(hook.result.current[0]).toBe("a failed after navigation");
  act(() => hook.result.current[1](null));
  hook.rerender({ id: "b" });
  expect(hook.result.current[0]).toBe("b failed");
});
