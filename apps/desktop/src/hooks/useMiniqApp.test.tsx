// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonEvent } from "../types";
import { useMiniqApp } from "./useMiniqApp";
import { AppShell } from "../components/AppShell";

const fake = vi.hoisted(() => ({
  call: vi.fn(),
  connect: vi.fn(),
  events: new Set<(event: DaemonEvent) => void>(),
}));
vi.mock("../rpc", () => ({
  RpcClient: class {
    call = fake.call;
    connect = fake.connect;
    connected = true;
    mode = "remote";
    onStatus() {
      return () => {};
    }
    onResync() {
      return () => {};
    }
    onEvent(listener: (event: DaemonEvent) => void) {
      fake.events.add(listener);
      return () => fake.events.delete(listener);
    }
  },
  resolveConnection: async () => ({ kind: "local", port: 9999, token: "test" }),
}));
vi.mock("./useTaskNotifications", () => ({ useTaskNotifications: () => {} }));
vi.mock("./useAppUpdater", () => ({ useAppUpdater: () => ({ state: { phase: "idle" } }) }));
afterEach(() => {
  cleanup();
  fake.call.mockReset();
  fake.connect.mockReset();
  fake.events.clear();
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  const sessions = ["a", "b"].map((id) => ({
    id,
    workspaceId: "w",
    workingDirectory: "/workspace",
    title: id,
    status: "running",
    createdAt: "2026-09-07",
    updatedAt: "2026-09-07",
  }));
  fake.connect.mockResolvedValue(undefined);
  fake.call.mockImplementation(async (method, params) => {
    switch (method) {
      case "daemon.health":
        return { daemonVersion: "test" };
      case "settings.get":
        return { approvalMode: "auto" };
      case "workspace.list":
        return { workspaces: [{ id: "w", name: "test", path: "/workspace", additionalPaths: [] }] };
      case "session.list":
        return { sessions };
      case "session.modelGet":
        return { settings: {}, effective: {} };
      case "session.diff":
        return { files: [], additions: 0, deletions: 0 };
      case "model.describe":
        return { reasoningEfforts: [] };
      case "agent.list":
        return {
          agents:
            params.sessionId === "a"
              ? [
                  {
                    agentId: "child-a",
                    name: "A child",
                    description: "only A",
                    status: "completed",
                    createdAt: "2026-09-07",
                  },
                ]
              : [],
        };
      case "session.open":
        return {
          session: sessions.find((s) => s.id === params.sessionId),
          messages: [],
          toolCalls: [
            {
              id: `tool-${params.sessionId}`,
              sessionId: params.sessionId,
              toolName: "agent_run",
              input: {},
              status: "running",
              createdAt: "2026-09-07",
            },
          ],
          plan: [
            { content: `${params.sessionId} plan`, status: "in_progress" },
          ],
          streamingText: `${params.sessionId} live`,
        };
      default:
        throw new Error(`unexpected method ${method}`);
    }
  });
});

it("switching failed, running and new sessions isolates state without reconnecting the transport", async () => {
  const hook = renderHook(useMiniqApp);
  await waitFor(() =>
    expect(hook.result.current.connection.connectionEpoch).toBe(1)
  );
  await act(async () => {
    await hook.result.current.actions.openSession("a");
  });
  await waitFor(() =>
    expect(hook.result.current.feed.toolCalls).toHaveLength(1)
  );
  act(() =>
    fake.events.forEach((listener) =>
      listener({ type: "turn_failed", sessionId: "a", error: "A failed" })
    )
  );
  expect(hook.result.current.error).toBe("A failed");
  await act(async () => {
    await hook.result.current.actions.openSession("b");
  });
  expect(hook.result.current.error).toBeNull();
  expect(
    hook.result.current.feed.toolCalls.map((call) => call.sessionId)
  ).toEqual(["b"]);
  act(() => hook.result.current.actions.newChat());
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.feed.plan).toEqual([]);
  expect(hook.result.current.feed.toolCalls).toEqual([]);
  expect(fake.connect).toHaveBeenCalledTimes(1);
  expect(
    fake.call.mock.calls.filter(([method]) => method === "session.open")
  ).toHaveLength(2);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  fake.call.mockRejectedValueOnce(new Error("B rename failed"));
  await act(async () => {
    await hook.result.current.actions.renameSession("b", "new name");
  });
  expect(hook.result.current.error).toBeNull();
  await act(async () => {
    await hook.result.current.actions.openSession("b");
  });
  expect(hook.result.current.error).toBe("B rename failed");
  logged.mockRestore();
});

it("acknowledges a viewed failure persistently without erasing task evidence or affecting another session", async () => {
  const original = fake.call.getMockImplementation()!;
  let status = "failed";
  fake.call.mockImplementation(async (method, params) => {
    if (method === "session.acknowledgeFailure") {
      expect(params).toEqual({ sessionId: "a", updatedAt: "failure-1" });
      status = "idle";
      return { acknowledged: true };
    }
    const result = await original(method, params);
    if (method === "session.list") {
      return { sessions: result.sessions.map((session: { id: string }) =>
        session.id === "a" ? { ...session, status, updatedAt: "failure-1" } : session) };
    }
    if (method === "session.open" && params.sessionId === "a") {
      return { ...result, canAcknowledgeFailure: true, session: { ...result.session, status, updatedAt: "failure-1" } };
    }
    return result;
  });
  const hook = renderHook(useMiniqApp);
  await waitFor(() => expect(hook.result.current.connection.connectionEpoch).toBe(1));
  await act(async () => { await hook.result.current.actions.openSession("a"); });
  expect(hook.result.current.catalog.currentSession?.status).toBe("idle");
  expect(hook.result.current.catalog.sessions.find((session) => session.id === "b")?.status).toBe("running");
  expect(hook.result.current.feed.plan).toEqual([{ content: "a plan", status: "in_progress" }]);
  expect(hook.result.current.feed.toolCalls).toHaveLength(1);
  await act(async () => {
    await hook.result.current.actions.openSession("b");
    await hook.result.current.actions.openSession("a");
  });
  expect(fake.call.mock.calls.filter(([method]) => method === "session.acknowledgeFailure")).toHaveLength(1);
  expect(fake.connect).toHaveBeenCalledTimes(1);
});

it("does not acknowledge background resyncs, failed loads, or a snapshot superseded by navigation", async () => {
  const original = fake.call.getMockImplementation()!;
  let resolveOpen!: (value: unknown) => void;
  const snapshot = await original("session.open", { sessionId: "a" });
  snapshot.session = { ...snapshot.session, status: "failed", updatedAt: "failure-1" };
  snapshot.canAcknowledgeFailure = true;
  let mode = "resync";
  fake.call.mockImplementation((method, params) => {
    if (method !== "session.open" || params.sessionId !== "a") return original(method, params);
    if (mode === "error") return Promise.reject(new Error("load failed"));
    if (mode === "delayed") return new Promise((resolve) => { resolveOpen = resolve; });
    return Promise.resolve(snapshot);
  });
  const hook = renderHook(useMiniqApp);
  await waitFor(() => expect(hook.result.current.connection.connectionEpoch).toBe(1));
  await act(async () => { await hook.result.current.actions.openSession("a", false); });
  mode = "error";
  await act(async () => { await hook.result.current.actions.openSession("a"); });
  mode = "delayed";
  let opening!: Promise<void>;
  act(() => { opening = hook.result.current.actions.openSession("a"); });
  await act(async () => { await hook.result.current.actions.openSession("b"); });
  await act(async () => { resolveOpen(snapshot); await opening; });
  expect(hook.result.current.catalog.currentSession?.id).toBe("b");
  expect(hook.result.current.feed.streamingText).toBe("b live");
  expect(fake.call.mock.calls.filter(([method]) => method === "session.acknowledgeFailure")).toHaveLength(0);
  expect(fake.connect).toHaveBeenCalledTimes(1);
});

it("opens failures without unsupported requests while the desktop is awaiting its update", async () => {
  const original = fake.call.getMockImplementation()!;
  fake.call.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    return method === "session.open"
      ? { ...result, session: { ...result.session, status: "failed" } }
      : result;
  });
  const hook = renderHook(useMiniqApp);
  await waitFor(() => expect(hook.result.current.connection.connectionEpoch).toBe(1));
  await act(async () => { await hook.result.current.actions.openSession("a"); });
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.feed.plan).toHaveLength(1);
  expect(fake.call.mock.calls.some(([method]) => method === "session.acknowledgeFailure")).toBe(false);
});

it("unmounts the complete session page without orphaned child-task DOM nodes", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  function TestApp() {
    return (
      <AppShell app={useMiniqApp()} theme="grid" onThemeChange={() => {}} />
    );
  }
  render(<TestApp />);
  await screen.findByRole("button", { name: "a，执行中" });
  fireEvent.click(screen.getByRole("button", { name: "a，执行中" }));
  fireEvent.click(await screen.findByRole("button", { name: /子任务.*总计/ }));
  expect(screen.getByText("A child")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "b，执行中" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "子任务" })).toBeNull()
  );
  fireEvent.click(screen.getByRole("button", { name: "a，执行中" }));
  await screen.findByRole("region", { name: "子任务" });
  fireEvent.click(screen.getByRole("button", { name: "新对话" }));
  expect(screen.queryByRole("region", { name: "子任务" })).toBeNull();
  expect(screen.queryByText("A child")).toBeNull();
  expect(
    logged.mock.calls.filter((args) =>
      args.some((arg) => String(arg).includes("same key"))
    )
  ).toEqual([]);
  logged.mockRestore();
});

it("coalesces session refreshes but reloads changes received during an in-flight snapshot", async () => {
  const hook = renderHook(useMiniqApp);
  await waitFor(() =>
    expect(hook.result.current.connection.connectionEpoch).toBe(1)
  );
  let resolveSnapshot!: (value: unknown) => void;
  const original = fake.call.getMockImplementation()!;
  fake.call.mockImplementation((method, params) => {
    if (method !== "session.list") return original(method, params);
    return new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
  });
  let refresh!: Promise<void>;
  act(() => {
    refresh = hook.result.current.catalog.refreshSessions();
  });
  const queued = hook.result.current.catalog.refreshSessions();
  expect(queued).toBe(refresh);
  const updated = {
    id: "new-session",
    title: "new task",
    workspaceId: "w",
    status: "idle",
  };
  fake.call.mockImplementation((method, params) =>
    method === "session.list"
      ? Promise.resolve({ sessions: [updated] })
      : original(method, params)
  );
  await act(async () => {
    resolveSnapshot({ sessions: [] });
    await refresh;
  });
  expect(hook.result.current.catalog.sessions).toEqual([updated]);
});
