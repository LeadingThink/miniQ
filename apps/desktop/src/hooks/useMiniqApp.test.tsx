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
import { DEFAULT_MODEL_SETTINGS, type SessionModelSettings } from "../modelSelection";

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
      case "workspace.modelGet":
        return { settings: DEFAULT_MODEL_SETTINGS, effective: null };
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

it("creates a task with its draft model before sending and preserves sibling model selections", async () => {
  const original = fake.call.getMockImplementation()!;
  const selections = new Map<string, SessionModelSettings>([
    ["a", { model: "gpt", apiProtocol: "responses", reasoningEffort: "high" }],
    ["b", { model: "claude", apiProtocol: "anthropic_messages", reasoningEffort: null }],
  ]);
  const projectDefault = { model: "gemini", apiProtocol: "auto", reasoningEffort: null } as const;
  fake.call.mockImplementation(async (method, params) => {
    if (method === "workspace.modelGet") return { settings: projectDefault, effective: projectDefault };
    if (method === "session.modelGet") return { settings: selections.get(params.sessionId), effective: selections.get(params.sessionId) };
    if (method === "session.create") {
      selections.set("new", params.modelSettings);
      return { id: "new", workspaceId: params.workspaceId };
    }
    if (method === "session.sendMessage") {
      expect(params.sessionId).toBe("new");
      expect(selections.get("new")).toEqual({ model: "new-model", apiProtocol: "responses", reasoningEffort: "low" });
      return {};
    }
    if (method === "session.open" && params.sessionId === "new") {
      const snapshot = await original("session.open", { sessionId: "a" });
      return { ...snapshot, session: { ...snapshot.session, id: "new" } };
    }
    return original(method, params);
  });
  const hook = renderHook(useMiniqApp);
  await waitFor(() => expect(hook.result.current.catalog.selectedWorkspace?.id).toBe("w"));
  await waitFor(() => expect(hook.result.current.sessionModel.ready).toBe(true));
  // The automatically selected project must supply the same defaults as an explicit selection.
  expect(hook.result.current.sessionModel.effective?.model).toBe("gemini");
  await act(async () => hook.result.current.sessionModel.update({ model: "new-model", apiProtocol: "responses", reasoningEffort: "low" }));
  await act(async () => expect(await hook.result.current.actions.startTask("test task")).toBe(true));
  expect(fake.call).toHaveBeenCalledWith("session.create", {
    workspaceId: "w",
    modelSettings: { model: "new-model", apiProtocol: "responses", reasoningEffort: "low" },
  });
  for (const [id, expectedModel] of [["a", "gpt"], ["b", "claude"], ["new", "new-model"]]) {
    await act(async () => hook.result.current.actions.openSession(id));
    await waitFor(() => expect(hook.result.current.sessionModel.effective?.model).toBe(expectedModel));
  }
  act(() => hook.result.current.actions.newChat());
  await waitFor(() => expect(hook.result.current.sessionModel.effective?.model).toBe("gemini"));
  expect(fake.call.mock.calls.some(([method]) => ["model.update", "workspace.modelUpdate"].includes(method))).toBe(false);
});

it("keeps the draft and sends no message when creating its model configuration fails", async () => {
  const original = fake.call.getMockImplementation()!;
  fake.call.mockImplementation((method, params) => method === "session.create"
    ? Promise.reject(new Error("model configuration rejected")) : original(method, params));
  const hook = renderHook(useMiniqApp);
  await waitFor(() => expect(hook.result.current.catalog.selectedWorkspace?.id).toBe("w"));
  await waitFor(() => expect(hook.result.current.sessionModel.ready).toBe(true));
  await act(async () => hook.result.current.sessionModel.update({ ...DEFAULT_MODEL_SETTINGS, model: "draft" }));
  await act(async () => expect(await hook.result.current.actions.startTask("test")).toBe(false));
  expect(hook.result.current.sessionModel.settings.model).toBe("draft");
  expect(hook.result.current.error).toContain("model configuration rejected");
  expect(fake.call.mock.calls.some(([method]) => method === "session.sendMessage")).toBe(false);
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

it("loads single-directory desktops during a rolling mobile deployment", async () => {
  const original = fake.call.getMockImplementation()!;
  fake.call.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === "workspace.list") return { workspaces: result.workspaces.map(({ additionalPaths: _paths, ...workspace }: Record<string, unknown>) => workspace) };
    if (method === "session.list") return { sessions: result.sessions.map(({ workingDirectory: _cwd, ...session }: Record<string, unknown>) => session) };
    return result;
  });
  const hook = renderHook(useMiniqApp);
  await waitFor(() => expect(hook.result.current.connection.connectionEpoch).toBe(1));
  await act(async () => { await hook.result.current.actions.openSession("a"); });
  expect(hook.result.current.catalog.currentWorkspacePaths).toEqual(["/workspace"]);
  expect(hook.result.current.catalog.currentSession?.workingDirectory).toBe("/workspace");
  expect(hook.result.current.catalog.workspaces[0].additionalPaths).toEqual([]);
  expect(hook.result.current.error).toBeNull();
  expect(fake.connect).toHaveBeenCalledTimes(1);
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

it("returns question delivery failures to the form and allows another attempt", async () => {
  const original = fake.call.getMockImplementation()!;
  const deliver = vi.fn()
    .mockRejectedValueOnce(new Error("connection interrupted"))
    .mockResolvedValueOnce(undefined);
  fake.call.mockImplementation((method, params) => method === "question.resolve"
    ? deliver(params)
    : original(method, params));
  const hook = renderHook(useMiniqApp);
  await waitFor(() => expect(hook.result.current.connection.connectionEpoch).toBe(1));
  await act(async () => {
    await expect(hook.result.current.actions.resolveQuestion("q", "existing files\n/new/video.mp4"))
      .rejects.toThrow("connection interrupted");
  });
  expect(hook.result.current.error).toBeNull();
  await act(async () => {
    await hook.result.current.actions.resolveQuestion("q", "existing files\n/new/video.mp4");
  });
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(deliver).toHaveBeenLastCalledWith({ questionId: "q", answer: "existing files\n/new/video.mp4" });
  expect(fake.connect).toHaveBeenCalledTimes(1);
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
  expect(hook.result.current.catalog.sessions).toEqual([{ ...updated, workingDirectory: "/workspace" }]);
});
