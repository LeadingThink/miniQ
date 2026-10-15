// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
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

function setup(mode: "local" | "remote" = "local", initialActive = true, statefulCatalog = false) {
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
    showRemoteFolder: false,
    setShowRemoteFolder: vi.fn(),
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
    settingsTab: undefined,
    openSettings: vi.fn(),
  };
  const feed: SessionFeed = {
    latestTurnTiming: null,
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
    turnPlans: [],
    artifacts: [],
    queue: [],
    streamingText: "",
    turnProgress: null,
    goal: null,
    reset: vi.fn(),
    load: vi.fn(),
    prepend: vi.fn(),
    failLoad: vi.fn(),
    applyReplay: vi.fn(),
  };
  const markSeen = vi.fn();
  const setError = vi.fn();
  let active = initialActive;
  const hook = renderHook(() => {
    const [sessionId, setSessionId] = useState<string | null>(null);
    if (statefulCatalog) {
      catalog.currentSessionId = sessionId;
      catalog.setCurrentSessionId = (id) => {
        catalog.navigationEpoch.current++;
        setSessionId(id);
      };
    }
    return useSessionLifecycleActions(
      client,
      catalog,
      navigation,
      feed,
      markSeen,
      setError,
      active,
    );
  });
  return { ...hook, call, selectSession, catalog, feed, markSeen, setError, setActive: (value: boolean) => { active = value; hook.rerender(); } };
}

const emptyPage: HistoryPage = {
  messages: [],
  toolCalls: [],
  nextCursor: null,
};

it.each([
  ["local", 100],
  ["remote", 16],
] as const)("opens %s history with a bounded first page of %i", async (mode, limit) => {
  const test = setup(mode);
  test.call.mockResolvedValue({
    session: { id: "a", workspaceId: "workspace", status: "idle" },
    messages: [],
    toolCalls: [],
    nextCursor: test.feed.nextCursor,
  });

  await act(async () => test.result.current.openSession("a"));

  expect(test.call).toHaveBeenCalledWith(
    "session.open",
    { sessionId: "a", limit },
    { signal: expect.any(AbortSignal) },
  );
  expect(test.feed.load).toHaveBeenCalledWith(
    "a",
    expect.objectContaining({ nextCursor: test.feed.nextCursor }),
  );
  if (mode === "remote") {
    expect(test.call).toHaveBeenCalledWith(
      "session.history",
      { sessionId: "a", before: test.feed.nextCursor, limit: 24 },
      { signal: expect.any(AbortSignal) },
    );
  }
});

it("cancels remote history prefetch when the user switches sessions", async () => {
  const test = setup("remote");
  const prefetch = deferred<HistoryPage>();
  test.call
    .mockResolvedValueOnce({
      session: { id: "a", workspaceId: "workspace", status: "idle" },
      messages: [],
      toolCalls: [],
      nextCursor: test.feed.nextCursor,
    })
    .mockReturnValueOnce(prefetch.promise);

  await act(async () => test.result.current.openSession("a"));
  const prefetchSignal = test.call.mock.calls[1][2]?.signal;
  expect(prefetchSignal?.aborted).toBe(false);

  test.catalog.currentSessionId = "b";
  test.catalog.navigationEpoch.current += 1;
  test.rerender();
  expect(prefetchSignal?.aborted).toBe(true);

  await act(async () => {
    prefetch.resolve(emptyPage);
    await Promise.resolve();
  });
  expect(test.feed.prepend).not.toHaveBeenCalled();
  expect(test.setError).not.toHaveBeenCalled();
});

it("serializes simultaneous top-of-history requests and accepts the next cursor", async () => {
  const test = setup();
  const request = deferred<HistoryPage>();
  test.call.mockReturnValueOnce(request.promise);
  let loading!: Promise<void | { error: unknown }>;

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

  // The RPC has settled, but the reducer has not published its next cursor.
  await act(async () => test.result.current.loadOlder());
  expect(test.call).toHaveBeenCalledTimes(1);

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
  let oldLoading!: Promise<void | { error: unknown }>;
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

  let newLoading!: Promise<void | { error: unknown }>;
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
  let loading!: Promise<void | { error: unknown }>;
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

it("finishes an opening load when the view is deactivated after cancellation", async () => {
  const test = setup();
  const request = deferred<unknown>();
  test.call.mockReturnValueOnce(request.promise);
  let loading!: Promise<void | { error: unknown }>;
  act(() => {
    loading = test.result.current.openSession("a");
  });
  const signal = test.call.mock.calls[0][2]?.signal;

  act(() => test.setActive(false));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    request.reject(new DOMException("Request cancelled", "AbortError"));
    await loading;
  });
  expect(test.feed.failLoad).toHaveBeenCalledWith("a");
  expect(test.setError).not.toHaveBeenCalled();
});

function openResult(cursor = { at: "2026-09-20T00:00:00Z", id: "a-first" }) {
  return {
    session: { id: "a", workspaceId: "workspace", status: "idle" },
    messages: [], toolCalls: [], nextCursor: cursor,
  };
}

it("keeps a separate prefetch alive through the first actual catalog commit", async () => {
  const test = setup("remote", true, true);
  const prefetch = deferred<HistoryPage>();
  test.call.mockResolvedValueOnce(openResult()).mockReturnValueOnce(prefetch.promise);
  expect(test.catalog.currentSessionId).toBeNull();
  await act(async () => test.result.current.openSession("a"));
  expect(test.catalog.currentSessionId).toBe("a");
  const openSignal = test.call.mock.calls[0][2]?.signal;
  const prefetchSignal = test.call.mock.calls[1][2]?.signal;
  expect(prefetchSignal).not.toBe(openSignal);
  expect(openSignal?.aborted).toBe(false);
  expect(prefetchSignal?.aborted).toBe(false);
  await act(async () => prefetch.resolve(emptyPage));
  expect(test.feed.prepend).toHaveBeenCalledExactlyOnceWith("a", emptyPage);
  await act(async () => test.result.current.loadOlder());
  expect(test.call).toHaveBeenCalledTimes(2);
});

it("deduplicates a consumed prefetch cursor before the feed commits", async () => {
  const test = setup("remote");
  const prefetch = deferred<HistoryPage>();
  test.call.mockResolvedValueOnce(openResult()).mockReturnValueOnce(prefetch.promise);
  await act(async () => test.result.current.openSession("a"));
  await act(async () => {
    prefetch.resolve(emptyPage);
    await prefetch.promise;
    await Promise.resolve();
    await test.result.current.loadOlder();
  });
  expect(test.call).toHaveBeenCalledTimes(2);
  expect(test.feed.prepend).toHaveBeenCalledTimes(1);
});

it("keeps failed prefetch silent and allows a manual retry of its cursor", async () => {
  const test = setup("remote");
  const prefetch = deferred<HistoryPage>();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  test.call.mockResolvedValueOnce(openResult()).mockReturnValueOnce(prefetch.promise);
  await act(async () => test.result.current.openSession("a"));
  await act(async () => prefetch.reject(new Error("private remote response")));
  expect(test.setError).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  test.call.mockResolvedValueOnce(emptyPage);
  await act(async () => test.result.current.loadOlder());
  expect(test.call).toHaveBeenLastCalledWith("session.history", {
    sessionId: "a", before: test.feed.nextCursor,
  }, { signal: expect.any(AbortSignal) });
  expect(test.feed.prepend).toHaveBeenCalledExactlyOnceWith("a", emptyPage);
});

it("holds an unpinned prefetch until anchored older-history loading consumes it", async () => {
  const test = setup("remote");
  const prefetch = deferred<HistoryPage>();
  test.call.mockResolvedValueOnce(openResult()).mockReturnValueOnce(prefetch.promise);
  await act(async () => test.result.current.openSession("a"));
  act(() => test.result.current.setHistoryPrefetchPinned(false));
  await act(async () => prefetch.resolve(emptyPage));
  expect(test.feed.prepend).not.toHaveBeenCalled();
  await act(async () => test.result.current.loadOlder());
  expect(test.feed.prepend).toHaveBeenCalledExactlyOnceWith("a", emptyPage);
  expect(test.call).toHaveBeenCalledTimes(2);
});

it("joins an in-flight prefetch when the reader requests older history", async () => {
  const test = setup("remote");
  const prefetch = deferred<HistoryPage>();
  test.call.mockResolvedValueOnce(openResult()).mockReturnValueOnce(prefetch.promise);
  await act(async () => test.result.current.openSession("a"));
  let loading!: Promise<void | { error: unknown }>;
  act(() => {
    test.result.current.setHistoryPrefetchPinned(false);
    loading = test.result.current.loadOlder();
  });
  expect(test.result.current.loadingOlder).toBe(true);
  await act(async () => { prefetch.resolve(emptyPage); await loading; });
  expect(test.feed.prepend).toHaveBeenCalledExactlyOnceWith("a", emptyPage);
  expect(test.result.current.loadingOlder).toBe(false);
  expect(test.call).toHaveBeenCalledTimes(2);
});

it("rejects an aborted same-session open even when the navigation epoch is unchanged", async () => {
  const test = setup();
  const old = deferred<unknown>();
  test.call.mockReturnValueOnce(old.promise).mockResolvedValueOnce(openResult());
  let opening!: Promise<void>;
  act(() => { opening = test.result.current.openSession("a"); });
  await act(async () => test.result.current.openSession("a"));
  await act(async () => { old.resolve(openResult()); await opening; });
  expect(test.feed.load).toHaveBeenCalledTimes(1);
  expect(test.markSeen).toHaveBeenCalledTimes(1);
});

it("rejects history after navigation changes before React runs cancellation effects", async () => {
  const test = setup();
  const page = deferred<HistoryPage>();
  test.call.mockReturnValueOnce(page.promise);
  let loading!: Promise<void | { error: unknown }>;
  act(() => { loading = test.result.current.loadOlder(); });
  test.catalog.navigationEpoch.current++;
  await act(async () => { page.resolve(emptyPage); await loading; });
  expect(test.feed.prepend).not.toHaveBeenCalled();
  expect(test.setError).not.toHaveBeenCalled();
});

it("isolates prefetch and consumed cursors for two hosts with identical session IDs", async () => {
  const first = setup("remote");
  const second = setup("remote");
  const page = deferred<HistoryPage>();
  first.call.mockResolvedValueOnce(openResult()).mockReturnValueOnce(page.promise);
  second.call.mockResolvedValueOnce(openResult()).mockResolvedValueOnce(emptyPage);
  await act(async () => {
    await first.result.current.openSession("a");
    await second.result.current.openSession("a");
  });
  expect(second.feed.prepend).toHaveBeenCalledTimes(1);
  expect(first.feed.prepend).not.toHaveBeenCalled();
  first.setActive(false);
  await act(async () => page.resolve(emptyPage));
  expect(first.feed.prepend).not.toHaveBeenCalled();
  expect(second.feed.prepend).toHaveBeenCalledTimes(1);
});

it("returns history failures safely and leaves the cursor retryable", async () => {
  const test = setup();
  const error = new Error("network unavailable");
  test.call.mockRejectedValueOnce(error).mockResolvedValueOnce(emptyPage);
  await act(async () => {
    expect(await test.result.current.loadOlder()).toEqual({ error });
  });
  expect(test.result.current.loadingOlder).toBe(false);
  await act(async () => { await test.result.current.loadOlder(); });
  expect(test.feed.prepend).toHaveBeenCalledExactlyOnceWith("a", emptyPage);
});
