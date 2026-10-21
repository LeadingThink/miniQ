// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { DaemonEvent, EventCursor } from "../types";
import type { Catalog, NavigationState } from "./useMiniqApp";
import { useSessionError } from "./useSessionError";
import { useSessionFeed } from "./useSessionFeed";
import { useSessionLifecycleActions } from "./useSessionLifecycleActions";

afterEach(cleanup);

const failure = "provider error: file download timed out (request id: original-request)\n" + "完整失败详情。".repeat(100);
const cursor = (sequence: number, epoch = "daemon") => ({ epoch, sequence });
const user = { id: "request", sessionId: "a", role: "user" as const, content: "执行任务", createdAt: "2026-10-21T01:00:00Z" };
const outcome = { anchorMessageId: user.id, status: "failed", error: failure };
const timing = { startedAt: user.createdAt, status: "failed" as const, completedAt: "2026-10-21T01:01:00Z" };

function snapshot(status: "failed" | "idle" | "running" = "failed") {
  return {
    session: { id: "a", workspaceId: "workspace", status, updatedAt: "failure-snapshot" },
    lastTurn: status === "running" ? null : outcome,
    latestTurnTiming: { messageId: user.id, timing: status === "running" ? { ...timing, status: "running" as const } : timing },
    eventCursor: cursor(1),
    canAcknowledgeFailure: true,
    messages: [user], toolCalls: [], artifacts: [], plan: [], queue: [], approvals: [], questions: [],
    streamingText: "", turnProgress: null, nextCursor: null,
  };
}

function server(initial = snapshot()) {
  const events = new Set<(event: DaemonEvent) => void>();
  const statuses = new Set<(connected: boolean) => void>();
  const state = {
    snapshot: initial,
    sync: { events: [] as DaemonEvent[] | null, eventCursor: cursor(1) as EventCursor },
  };
  const call = vi.fn(async (method: string) => {
    if (method === "session.open") return structuredClone(state.snapshot);
    if (method === "session.sync") return structuredClone(state.sync);
    if (method === "session.acknowledgeFailure") {
      state.snapshot.session.status = "idle";
      return { acknowledged: true, session: structuredClone(state.snapshot.session) };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const client = {
    mode: "remote",
    call,
    selectSession: vi.fn(),
    onStatus: (listener: (connected: boolean) => void) => { statuses.add(listener); return () => statuses.delete(listener); },
    onResync: () => () => {},
    onEvent: (listener: (event: DaemonEvent) => void) => { events.add(listener); return () => events.delete(listener); },
  } as unknown as RpcClient;
  return {
    state, call, client,
    emit: (event: DaemonEvent) => act(() => events.forEach((listener) => listener(event))),
    disconnect: () => act(() => statuses.forEach((listener) => listener(false))),
  };
}

function mount(remote: ReturnType<typeof server>) {
  const refreshSessions = vi.fn().mockResolvedValue(undefined);
  const markSeen = vi.fn();
  const navigation = { setPage: vi.fn() } as unknown as NavigationState;
  const hook = renderHook(() => {
    const [sessionId, selectSession] = useState<string | null>("a");
    const navigationEpoch = useRef(0);
    const setCurrentSessionId = useCallback((id: string | null) => {
      navigationEpoch.current++;
      selectSession(id);
    }, []);
    const [error, , setSessionError] = useSessionError(sessionId ?? "draft");
    const catalog = {
      currentSessionId: sessionId, navigationEpoch, setCurrentSessionId, refreshSessions,
      setSelectedWorkspaceId: vi.fn(),
    } as unknown as Catalog;
    const feed = useSessionFeed({
      client: remote.client, currentSessionId: sessionId, refreshSessions,
      onSessionStatusChanged: vi.fn(), onSessionCompleted: vi.fn(), onError: setSessionError,
    });
    const actions = useSessionLifecycleActions(remote.client, catalog, navigation, feed, markSeen, setSessionError);
    return { feed, actions, error };
  });
  return { ...hook, markSeen, refreshSessions };
}

it("restores the complete failure after leaving the app and after the badge was acknowledged", async () => {
  const remote = server();
  const first = mount(remote);
  await act(async () => first.result.current.actions.openSession("a"));
  expect(first.result.current.feed.lastTurn).toEqual(outcome);
  expect(remote.state.snapshot.session.status).toBe("idle");
  expect(remote.call.mock.calls.filter(([method]) => method === "session.acknowledgeFailure")).toHaveLength(1);

  first.unmount();
  const reopened = mount(remote);
  await act(async () => reopened.result.current.actions.openSession("a"));
  expect(reopened.result.current.feed.lastTurn).toEqual(outcome);
  expect(reopened.result.current.feed.lastTurn?.error).toHaveLength(failure.length);
  expect(remote.call.mock.calls.filter(([method]) => method === "session.acknowledgeFailure")).toHaveLength(1);
});

it("recovers a missed failure by replaying the disconnected session events", async () => {
  const remote = server(snapshot("running"));
  const hook = mount(remote);
  await act(async () => hook.result.current.actions.openSession("a"));
  remote.disconnect();
  remote.state.sync = { events: [
    { type: "turn_timing_changed", sessionId: "a", messageId: user.id, timing, eventCursor: cursor(2) },
    { type: "turn_failed", sessionId: "a", error: failure, eventCursor: cursor(3) },
  ], eventCursor: cursor(3) };
  await act(async () => hook.result.current.actions.syncSession("a"));
  expect(hook.result.current.feed.lastTurn).toEqual(outcome);
  expect(hook.result.current.feed.syncing).toBe(false);
  expect(remote.call.mock.calls.filter(([method]) => method === "session.open")).toHaveLength(1);
});

it("restores the durable failure from a fresh snapshot when the replay cursor expired", async () => {
  const remote = server(snapshot("running"));
  const hook = mount(remote);
  await act(async () => hook.result.current.actions.openSession("a"));
  remote.disconnect();
  remote.state.snapshot = { ...snapshot(), eventCursor: cursor(1, "restarted-daemon") };
  remote.state.sync = { events: null, eventCursor: cursor(1, "restarted-daemon") };
  await act(async () => hook.result.current.actions.syncSession("a"));
  expect(hook.result.current.feed.lastTurn).toEqual(outcome);
  expect(hook.result.current.feed.eventCursor?.epoch).toBe("restarted-daemon");
  // Background recovery does not acknowledge a failure the user has not opened.
  expect(remote.call.mock.calls.some(([method]) => method === "session.acknowledgeFailure")).toBe(false);
});

it("clears a previous failure on a new request and a rewrite, and preserves cancellation as cancellation", async () => {
  const remote = server(snapshot("idle"));
  const hook = mount(remote);
  await act(async () => hook.result.current.actions.openSession("a"));
  const next = { ...user, id: "next", content: "继续执行", createdAt: "2026-10-21T02:00:00Z" };
  remote.emit({ type: "message_created", sessionId: "a", message: next, eventCursor: cursor(2) });
  expect(hook.result.current.feed.lastTurn).toBeNull();
  remote.emit({ type: "turn_failed", sessionId: "a", error: "second failure", eventCursor: cursor(3) });
  expect(hook.result.current.feed.lastTurn?.anchorMessageId).toBe(next.id);
  remote.emit({ type: "session_rewritten", sessionId: "a", message: { ...next, content: "修改后重试" },
    removedMessageIds: [], removedToolCallIds: [], removedArtifactIds: [], eventCursor: cursor(4) });
  expect(hook.result.current.feed.lastTurn).toBeNull();
  remote.emit({ type: "turn_failed", sessionId: "a", error: "cancelled", eventCursor: cursor(5) });
  expect(hook.result.current.feed.lastTurn?.status).toBe("cancelled");
  expect(hook.result.current.feed.lastTurn?.anchorMessageId).toBe(next.id);
});

it("keeps a newer failure that arrives while an older open snapshot is still loading", async () => {
  const remote = server(snapshot("running"));
  const hook = mount(remote);
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  remote.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  let opening!: Promise<void>;
  act(() => { opening = hook.result.current.actions.openSession("a"); });
  remote.emit({ type: "turn_timing_changed", sessionId: "a", messageId: user.id, timing, eventCursor: cursor(2) });
  remote.emit({ type: "turn_failed", sessionId: "a", error: failure, eventCursor: cursor(3) });
  await act(async () => { resolve(snapshot("running")); await opening; });
  expect(hook.result.current.feed.lastTurn).toEqual(outcome);
  expect(hook.result.current.feed.eventCursor).toEqual(cursor(3));
});
