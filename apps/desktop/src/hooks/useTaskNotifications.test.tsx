// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostEvent, RpcClient } from "../rpc";
import type { DaemonEvent, Session } from "../types";
import { emptyCatalog, hostKey, type HostCatalog } from "../hostWorkspace";
import { useTaskNotifications } from "./useTaskNotifications";

const notifyTaskResult = vi.hoisted(() => vi.fn());
const badge = vi.hoisted(() => ({ recordTurnEnd: vi.fn(), clear: vi.fn() }));
const disposeFocus = vi.hoisted(() => vi.fn());
vi.mock("../taskNotifications", () => ({ notifyTaskResult }));
vi.mock("../turnBadge", () => ({ createTurnBadge: () => badge, clearTurnBadgeOnFocus: () => disposeFocus }));
beforeEach(() => {
  notifyTaskResult.mockReset();
  badge.recordTurnEnd.mockReset();
  badge.clear.mockReset();
  disposeFocus.mockReset();
});
afterEach(cleanup);

function catalog(host: string | null, label: string, title: string): HostCatalog {
  return { ...emptyCatalog(host, label), state: "connected", sessions: [{ id: "same-session", title } as Session] };
}

function setup(strict = false) {
  const local = new Set<(event: DaemonEvent) => void>();
  const hosts = new Set<(event: HostEvent) => void>();
  const root = {
    onEvent: vi.fn((listener: (event: DaemonEvent) => void) => {
      local.add(listener);
      return () => { local.delete(listener); };
    }),
    onHostEvent: vi.fn((listener: (event: HostEvent) => void) => {
      hosts.add(listener);
      return () => { hosts.delete(listener); };
    }),
  } as unknown as RpcClient;
  const catalogs = {
    [hostKey(null)]: catalog(null, "本机", "本机任务"),
    [hostKey("alpha")]: catalog("alpha", "开发电脑", "开发任务"),
    [hostKey("beta")]: catalog("beta", "测试电脑", "测试任务"),
  };
  const hook = renderHook(({ entries }) => useTaskNotifications(root, entries), {
    initialProps: { entries: catalogs },
    wrapper: strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined,
  });
  const emit = (host: string | null, event: DaemonEvent) => act(() => {
    if (host === null) local.forEach((listener) => listener(event));
    else hosts.forEach((listener) => listener({ type: "host_event", hostId: host, event }));
  });
  return { ...hook, root, local, hosts, catalogs, emit };
}

it("isolates equal session IDs on local and multiple SSH hosts and never forwards raw errors", () => {
  const hook = setup();
  const done: DaemonEvent = { type: "turn_completed", sessionId: "same-session", eventCursor: { epoch: "run", sequence: 1 } };
  hook.emit(null, done);
  hook.emit("alpha", done);
  hook.emit("beta", { ...done, type: "turn_failed", error: "provider failed with sk-private-secret" });
  expect(notifyTaskResult.mock.calls).toEqual([
    ["completed", "本机任务", { host: null, sessionId: "same-session" }, expect.stringContaining('"same-session","completed"')],
    ["completed", "开发电脑 · 开发任务", { host: "alpha", sessionId: "same-session" }, expect.stringContaining('"same-session","completed"')],
    ["failed", "测试电脑 · 测试任务", { host: "beta", sessionId: "same-session" }, expect.stringContaining('"same-session","failed"')],
  ]);
  expect(JSON.stringify(notifyTaskResult.mock.calls)).not.toContain("sk-private-secret");
});

it("uses updated host labels and titles without adding subscriptions on rerender", () => {
  const hook = setup();
  hook.rerender({ entries: { ...hook.catalogs, [hostKey("alpha")]: catalog("alpha", "新电脑名", "新标题") } });
  hook.emit("alpha", { type: "turn_completed", sessionId: "same-session" });
  expect(notifyTaskResult).toHaveBeenCalledWith("completed", "新电脑名 · 新标题", { host: "alpha", sessionId: "same-session" }, expect.stringContaining('"same-session","completed"'));
  expect(hook.root.onEvent).toHaveBeenCalledTimes(1);
  expect(hook.root.onHostEvent).toHaveBeenCalledTimes(1);
});

it("deduplicates replayed terminal cursors without losing the next turn or restarted daemon", () => {
  const hook = setup();
  const event: DaemonEvent = { type: "turn_completed", sessionId: "same-session", eventCursor: { epoch: "first", sequence: 20 } };
  hook.emit("alpha", event);
  hook.emit("alpha", event);
  hook.emit("alpha", { ...event, eventCursor: { epoch: "first", sequence: 19 } });
  expect(notifyTaskResult).toHaveBeenCalledTimes(1);
  hook.emit("alpha", { ...event, eventCursor: { epoch: "first", sequence: 30 } });
  hook.emit("alpha", { ...event, eventCursor: { epoch: "restarted", sequence: 1 } });
  expect(notifyTaskResult).toHaveBeenCalledTimes(3);
});

it("retains notification delivery for legacy events without cursors", () => {
  const hook = setup();
  const event: DaemonEvent = { type: "turn_completed", sessionId: "same-session" };
  hook.emit("alpha", event);
  hook.emit("alpha", event);
  expect(notifyTaskResult).toHaveBeenCalledTimes(2);
});

it("never borrows a local title when an SSH catalog is not yet loaded", () => {
  const hook = setup();
  hook.emit("not-loaded", { type: "turn_completed", sessionId: "same-session" });
  expect(notifyTaskResult).toHaveBeenCalledWith("completed", "not-loaded · 当前会话", { host: "not-loaded", sessionId: "same-session" }, expect.stringContaining('"same-session","completed"'));
});

it("keeps one active subscription in StrictMode and removes both subscriptions on unmount", () => {
  const hook = setup(true);
  expect(hook.local.size).toBe(1);
  expect(hook.hosts.size).toBe(1);
  hook.emit("alpha", { type: "turn_completed", sessionId: "same-session" });
  expect(notifyTaskResult).toHaveBeenCalledTimes(1);
  hook.unmount();
  expect(hook.local.size).toBe(0);
  expect(hook.hosts.size).toBe(0);
});

it("adds one badge count per new turn end across hosts and skips replays and other events", () => {
  const hook = setup();
  const done: DaemonEvent = { type: "turn_completed", sessionId: "same-session", eventCursor: { epoch: "run", sequence: 1 } };
  hook.emit(null, done);
  hook.emit("alpha", { ...done, type: "turn_failed", error: "failed" });
  hook.emit("alpha", { ...done, type: "turn_failed", error: "failed" });
  hook.emit("alpha", { type: "session_deleted", sessionId: "other" });
  expect(badge.recordTurnEnd).toHaveBeenCalledTimes(2);
});

it("clears the badge and stops focus tracking on unmount", () => {
  const hook = setup();
  hook.unmount();
  expect(disposeFocus).toHaveBeenCalledTimes(1);
  expect(badge.clear).toHaveBeenCalledTimes(1);
});
