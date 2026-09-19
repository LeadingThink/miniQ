// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RpcClient } from "../rpc";
import type { HistoryPage } from "../types";
import type { Catalog, NavigationState, SessionFeed } from "./useMiniqApp";
import { useSessionLifecycleActions } from "./useSessionLifecycleActions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(mode: "local" | "remote" = "local") {
  const client = new RpcClient();
  vi.spyOn(client, "mode", "get").mockReturnValue(mode);
  const call = vi.spyOn(client, "call");
  const selectSession = vi.spyOn(client, "selectSession");
  const catalog: Catalog = {
    workspaces: [],
    sessions: [],
    selectedWorkspaceId: "workspace",
    currentSessionId: "a",
    navigationEpoch: { current: 0 },
    currentSession: null,
    selectedWorkspace: {
      id: "workspace",
      name: "Test",
      path: "/workspace",
      additionalPaths: [],
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
    },
    currentWorkspace: null,
    currentWorkspacePaths: [],
    setSelectedWorkspaceId: vi.fn(),
    setCurrentSessionId: vi.fn(),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn(),
  };
  const navigation: NavigationState = {
    editingWorkspaceId: null,
    setEditingWorkspaceId: vi.fn(),
    showExternalImport: false,
    setShowExternalImport: vi.fn(),
    showSettings: false,
    showDistill: false,
    showSearch: false,
    sidebarCollapsed: false,
    page: null,
    setShowSettings: vi.fn(),
    setShowDistill: vi.fn(),
    setShowSearch: vi.fn(),
    setSidebarCollapsed: vi.fn(),
    setPage: vi.fn(),
  };
  const feed: SessionFeed = {
    eventCursor: null,
    buffered: [],
    loading: false,
    syncing: false,
    nextCursor: { at: "2026-09-20T00:00:00Z", id: "a-first" },
    messages: [],
    toolCalls: [],
    approvals: [],
    questions: [],
    plan: [],
    artifacts: [],
    queue: [],
    streamingText: "",
    turnProgress: null,
    reset: vi.fn(),
    load: vi.fn(),
    prepend: vi.fn(),
    failLoad: vi.fn(),
    applyReplay: vi.fn(),
  };
  const markSeen = vi.fn();
  const setError = vi.fn();
  const hook = renderHook(() =>
    useSessionLifecycleActions(
      client,
      catalog,
      navigation,
      feed,
      markSeen,
      setError,
    ),
  );
  return { ...hook, call, selectSession, catalog, feed, markSeen, setError };
}

const emptyPage: HistoryPage = {
  messages: [],
  toolCalls: [],
  nextCursor: null,
};

it.each([
  ["local", 100],
  ["remote", 40],
] as const)("opens %s history with a bounded first page of %i", async (mode, limit) => {
  const test = setup(mode);
  test.call.mockResolvedValue({
    session: { id: "a", workspaceId: "workspace", status: "idle" },
    messages: [],
    toolCalls: [],
    nextCursor: test.feed.nextCursor,
  });

  await act(async () => test.result.current.openSession("a"));

  expect(test.call).toHaveBeenCalledExactlyOnceWith(
    "session.open",
    { sessionId: "a", limit },
    { signal: expect.any(AbortSignal) },
  );
  expect(test.feed.load).toHaveBeenCalledWith(
    "a",
    expect.objectContaining({ nextCursor: test.feed.nextCursor }),
  );
});

it("serializes simultaneous top-of-history requests and accepts the next cursor", async () => {
  const test = setup();
  const request = deferred<HistoryPage>();
  test.call.mockReturnValueOnce(request.promise);
  let loading!: Promise<void>;

  act(() => {
    loading = test.result.current.loadOlder();
    void test.result.current.loadOlder();
    void test.result.current.loadOlder();
  });
  expect(test.result.current.loadingOlder).toBe(true);
  expect(test.call).toHaveBeenCalledTimes(1);
  expect(test.call).toHaveBeenLastCalledWith(
    "session.history",
    { sessionId: "a", before: test.feed.nextCursor },
    { signal: expect.any(AbortSignal) },
  );

  const nextPage = {
    ...emptyPage,
    nextCursor: { at: "2026-09-19T00:00:00Z", id: "a-older" },
  };
  await act(async () => {
    request.resolve(nextPage);
    await loading;
  });
  expect(test.feed.prepend).toHaveBeenCalledExactlyOnceWith("a", nextPage);
  expect(test.result.current.loadingOlder).toBe(false);

  test.feed.nextCursor = nextPage.nextCursor;
  test.rerender();
  test.call.mockResolvedValueOnce(emptyPage);
  await act(async () => test.result.current.loadOlder());
  expect(test.call).toHaveBeenLastCalledWith(
    "session.history",
    { sessionId: "a", before: nextPage.nextCursor },
    { signal: expect.any(AbortSignal) },
  );
});

it("cancels old history on session switch without mixing pages or clearing a new request", async () => {
  const test = setup();
  const oldRequest = deferred<HistoryPage>();
  const newRequest = deferred<HistoryPage>();
  test.call
    .mockReturnValueOnce(oldRequest.promise)
    .mockReturnValueOnce(newRequest.promise);
  let oldLoading!: Promise<void>;
  act(() => {
    oldLoading = test.result.current.loadOlder();
  });
  const oldSignal = test.call.mock.calls[0][2]?.signal;
  expect(oldSignal?.aborted).toBe(false);

  test.catalog.currentSessionId = "b";
  test.catalog.navigationEpoch.current += 1;
  test.feed.nextCursor = { at: "2026-09-20T01:00:00Z", id: "b-first" };
  test.rerender();
  expect(oldSignal?.aborted).toBe(true);
  expect(test.result.current.loadingOlder).toBe(false);
  expect(test.selectSession).toHaveBeenLastCalledWith("b");

  let newLoading!: Promise<void>;
  act(() => {
    newLoading = test.result.current.loadOlder();
  });
  await act(async () => {
    oldRequest.resolve(emptyPage);
    await oldLoading;
  });
  expect(test.feed.prepend).not.toHaveBeenCalled();
  expect(test.result.current.loadingOlder).toBe(true);
  expect(test.setError).not.toHaveBeenCalled();
  await act(async () => {
    newRequest.resolve(emptyPage);
    await newLoading;
  });
  expect(test.feed.prepend).toHaveBeenCalledExactlyOnceWith("b", emptyPage);
  expect(test.result.current.loadingOlder).toBe(false);
});

it("aborts paging on unmount without surfacing a cancelled request as an error", async () => {
  const test = setup();
  const request = deferred<HistoryPage>();
  test.call.mockReturnValueOnce(request.promise);
  let loading!: Promise<void>;
  act(() => {
    loading = test.result.current.loadOlder();
  });
  const signal = test.call.mock.calls[0][2]?.signal;

  test.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    request.reject(new DOMException("Request cancelled", "AbortError"));
    await loading;
  });
  expect(test.feed.prepend).not.toHaveBeenCalled();
  expect(test.setError).not.toHaveBeenCalled();
});
