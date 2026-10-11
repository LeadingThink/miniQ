// @vitest-environment jsdom
import { createRef, StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PAGE_LOAD_GRACE_MS, PAGE_LOAD_SAFETY_MS, useBrowserPanel } from "./useBrowserPanel";
import {
  browserAction,
  closeBrowser,
  currentBrowser,
  evaluateBrowser,
  openBrowser,
  resizeBrowser,
  screenshotBrowser,
  setBrowserVisible,
} from "../browserWorkbench";
import { executeEmbeddedBrowserRequest } from "../embeddedBrowserDriver";
import { isTauriRuntime } from "../runtime";

vi.mock("../runtime", () => ({ isTauriRuntime: vi.fn(() => false) }));
const { nativeListeners } = vi.hoisted(() => ({
  nativeListeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const set = nativeListeners.get(name) ?? new Set();
    set.add(handler);
    nativeListeners.set(name, set);
    return () => set.delete(handler);
  }),
}));
const emitNative = (name: string, payload: unknown) =>
  act(() => nativeListeners.get(name)?.forEach((handler) => handler({ payload })));
vi.mock("../browserWorkbench", async (original) => ({
  ...(await original<typeof import("../browserWorkbench")>()),
  browserCapabilities: vi.fn(async () => ({
    navigationControl: false,
    domSnapshot: true,
    screenshot: false,
    tabs: false,
    pointerInput: true,
    keyboardInput: true,
    selectInput: true,
  })),
  openBrowser: vi.fn(async (url: string) => ({ url })),
  closeBrowser: vi.fn(async () => {}),
  resizeBrowser: vi.fn(async () => {}),
  setBrowserVisible: vi.fn(async () => {}),
  currentBrowser: vi.fn(async () => null),
  browserAction: vi.fn(async () => null),
  evaluateBrowser: vi.fn(async (_viewId: string, script: string) =>
    JSON.stringify(eval(script)),
  ),
  screenshotBrowser: vi.fn(async () => "native-png-base64"),
}));
beforeEach(() => {
  vi.clearAllMocks();
  nativeListeners.clear();
  vi.mocked(isTauriRuntime).mockReturnValue(false);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const surface = () => {
  const ref = createRef<HTMLDivElement>();
  Object.assign(ref, { current: document.createElement("div") });
  ref.current!.getBoundingClientRect = () =>
    ({ x: 600, y: 90, width: 500, height: 650 }) as DOMRect;
  return ref;
};

it("updates native bounds even when animation frames are suspended", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const raf = vi.fn();
  vi.stubGlobal("requestAnimationFrame", raf);
  let notify!: () => void;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const ref = surface();
  ref.current!.getBoundingClientRect = () =>
    ({ x: 600, y: 90, width: 500, height: 650 }) as DOMRect;
  const view = renderHook(() => useBrowserPanel("https://example.test/", ref));
  await waitFor(() => expect(view.result.current.pending).toBe(false));
  act(() => notify());
  expect(resizeBrowser).toHaveBeenLastCalledWith(
    { x: 600, y: 90, width: 500, height: 650 },
    expect.any(String),
  );
  expect(raf).not.toHaveBeenCalled();
});

it("reloads web previews with a new iframe revision", async () => {
  const ref = surface();
  const { result } = renderHook(() =>
    useBrowserPanel("https://example.test/", ref),
  );
  await waitFor(() => expect(result.current.pending).toBe(false));
  const previous = result.current.revision;
  await act(() => result.current.action("reload"));
  expect(result.current.revision).toBe(previous + 1);
  expect(result.current.loading).toBe(true);
});

it("a late open can close only its old instance, not the new session", async () => {
  let finish!: (value: { url: string }) => void;
  vi.mocked(openBrowser).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const oldRef = surface();
  const old = renderHook(() => useBrowserPanel("https://old.test/", oldRef));
  const oldId = vi.mocked(openBrowser).mock.calls[0][2];
  old.unmount();
  const nextRef = surface();
  const next = renderHook(() => useBrowserPanel("https://new.test/", nextRef));
  await waitFor(() => expect(next.result.current.pending).toBe(false));
  const newId = vi.mocked(openBrowser).mock.calls[1][2];
  expect(newId).not.toBe(oldId);
  await act(async () => {
    finish({ url: "https://old.test/" });
  });
  expect(closeBrowser).toHaveBeenCalledWith(oldId);
  expect(closeBrowser).not.toHaveBeenCalledWith(newId);
  expect(next.result.current.activeUrl).toBe("https://new.test/");
});

it("ignores stale native polls after a navigation", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  let finish!: (value: { url: string }) => void;
  vi.mocked(currentBrowser).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ref = surface();
  const { result } = renderHook(() =>
    useBrowserPanel("https://old.test/", ref),
  );
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(1500));
  await act(() => result.current.load("https://new.test/"));
  await act(async () => {
    finish({ url: "https://stale.test/" });
  });
  expect(result.current.activeUrl).toBe("https://new.test/");
});

it("hides the native child behind settings without discarding the page", async () => {
  const ref = surface();
  const { result, rerender } = renderHook(
    ({ suspended }) => useBrowserPanel("https://example.test/", ref, suspended),
    {
      initialProps: { suspended: false },
    },
  );
  await waitFor(() => expect(result.current.pending).toBe(false));
  const viewId = vi.mocked(openBrowser).mock.calls[0][2];
  rerender({ suspended: true });
  expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, false);
  rerender({ suspended: false });
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, true));
  expect(openBrowser).toHaveBeenCalledTimes(1);
});

it("allows stopping a native navigation while it is pending", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  let finish!: (value: { url: string }) => void;
  vi.mocked(openBrowser).mockImplementationOnce(
    () => new Promise((resolve) => {
      finish = resolve;
    }),
  );
  vi.mocked(browserAction).mockResolvedValueOnce({ url: "https://example.test/" });
  const ref = surface();
  const { result } = renderHook(() => useBrowserPanel("https://example.test/", ref));
  await act(async () => {
    await result.current.action("stop");
  });
  expect(browserAction).toHaveBeenCalledWith("stop", expect.any(String));
  expect(result.current.pending).toBe(false);
  expect(result.current.loading).toBe(false);
  await act(async () => finish({ url: "https://example.test/" }));
});

it("bridges open observations into a following observation-bound click", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  document.body.innerHTML = '<button id="save">Save</button>';
  const button = document.querySelector("button")!;
  Object.defineProperty(document.body, "innerText", { configurable: true, value: "Save" });
  Object.defineProperty(button, "innerText", { configurable: true, value: "Save" });
  button.getBoundingClientRect = () =>
    ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 }) as DOMRect;
  vi.mocked(evaluateBrowser).mockImplementation(async (_viewId, script) => {
    const result = JSON.parse(eval(script)) as Record<string, unknown>;
    return JSON.stringify(JSON.stringify(result));
  });
  const ref = surface();
  renderHook(() => useBrowserPanel(
    "https://example.test/",
    ref,
    false,
    "view-1",
    "browser-session-1",
  ));
  const opened = await executeEmbeddedBrowserRequest("view-1", "open", {
    url: "https://example.test/",
    nextObservationId: "observation-1",
  });
  const observation = opened.result;
  expect(observation).toEqual(expect.objectContaining({
    observationId: "observation-1",
    tabId: "view-1",
  }));

  const clicked = await executeEmbeddedBrowserRequest("view-1", "click", {
    nextObservationId: "observation-2",
    observationId: "observation-1",
    target: "rpa-observation-1-0",
    expectedObservation: observation,
  });
  expect(clicked.result).toMatchObject({ observationId: "observation-2", tabId: "view-1" });
  // The click is followed by a fresh DOM snapshot so submit/next-page
  // navigation cannot leave the agent bound to the pre-click document.
  // Open and click each wait for a stable post-mutation observation. The
  // exact number is an implementation detail; assert that the click caused
  // additional snapshots instead of replaying the click.
  expect(vi.mocked(evaluateBrowser).mock.calls.length).toBeGreaterThanOrEqual(6);
});

it("routes history actions through the native browser and settles delayed SPA updates", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const ref = surface();
  let snapshots = 0;
  let backSnapshots = 0;
  let phase: "open" | "back" = "open";
  const observation = (url: string, text: string, documentId: string) => ({
    observationId: "stable-observation",
    url,
    tabId: "view-history",
    documentId,
    title: "Survey",
    viewport: {
      width: 900,
      height: 600,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
    },
    total: 1,
    offset: 0,
    limit: 100,
    items: [{ text }],
    textLines: [text],
    totalTextLines: 1,
    hasMore: false,
    readyState: "complete",
  });
  vi.mocked(evaluateBrowser).mockImplementation(async () => {
    // Open settles on three identical snapshots. Back first sees the old SPA
    // DOM, then the new route; the hook must wait for the new DOM to settle.
    const value = phase === "open" || backSnapshots++ === 0
      ? observation("https://example.test/first", "First page", "document-a")
      : observation("https://example.test/second", "Second page", "document-b");
    snapshots += 1;
    return JSON.stringify(JSON.stringify(value));
  });
  vi.mocked(browserAction).mockImplementation(async () => {
    phase = "back";
    return { url: "https://example.test/second" };
  });
  renderHook(() => useBrowserPanel(
    "https://example.test/first",
    ref,
    false,
    "view-history",
    "browser-history",
  ));
  const arguments_ = {
      nextObservationId: "stable-observation",
      observationId: "stable-observation",
      expectedObservation: {
        observationId: "stable-observation",
        url: "https://example.test/first",
        tabId: "view-history",
        documentId: "document-a",
        viewport: { width: 900, height: 600, scrollX: 0, scrollY: 0 },
      },
  };
  await executeEmbeddedBrowserRequest("view-history", "open", { url: "https://example.test/first", nextObservationId: "stable-observation" });
  const response = await executeEmbeddedBrowserRequest("view-history", "back", arguments_);

  expect(browserAction).toHaveBeenCalledWith("back", "view-history");
  expect(browserAction).toHaveBeenCalledTimes(1);
  expect(response.result).toEqual(expect.objectContaining({
    url: "https://example.test/second",
    textLines: ["Second page"],
  }));
  // The open and history action each need a fresh observation; the history
  // action must also sample the settled SPA DOM instead of trusting the first
  // response. The exact number of samples is intentionally an implementation
  // detail of the quiet-window debounce.
  expect(snapshots).toBeGreaterThanOrEqual(4);
});

it("stops polling hidden tabs and resumes without reloading their page", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const ref = surface();
  const { rerender } = renderHook(({ suspended }) => useBrowserPanel("https://example.test/", ref, suspended), { initialProps: { suspended: false } });
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(currentBrowser).toHaveBeenCalledTimes(1);
  rerender({ suspended: true });
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(currentBrowser).toHaveBeenCalledTimes(1);
  rerender({ suspended: false });
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(currentBrowser).toHaveBeenCalledTimes(2);
  expect(openBrowser).toHaveBeenCalledTimes(1);
});

it("opens native pages hidden and uses the latest panel bounds before showing", async () => {
  let finish!: (value: { url: string }) => void;
  vi.mocked(openBrowser).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const ref = surface();
  const { result } = renderHook(() => useBrowserPanel("https://example.test/", ref, false, "view-geometry"));
  expect(openBrowser).toHaveBeenCalledWith("https://example.test/", expect.any(Object), "view-geometry", false);
  ref.current!.getBoundingClientRect = () => ({ x: 700, y: 100, width: 450, height: 550 }) as DOMRect;
  await act(async () => { finish({ url: "https://example.test/" }); });
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(resizeBrowser).toHaveBeenLastCalledWith({ x: 700, y: 100, width: 450, height: 550 }, "view-geometry");
  expect(setBrowserVisible).toHaveBeenLastCalledWith("view-geometry", true);
  expect(vi.mocked(resizeBrowser).mock.invocationCallOrder.at(-1))
    .toBeLessThan(vi.mocked(setBrowserVisible).mock.invocationCallOrder.at(-1)!);
});

it("does not expose a zero-sized or newly suspended panel after a late resize", async () => {
  const ref = surface();
  ref.current!.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
  const { result, rerender } = renderHook(({ suspended }) =>
    useBrowserPanel("https://example.test/", ref, suspended, "view-hidden"),
  { initialProps: { suspended: false } });
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(setBrowserVisible).not.toHaveBeenCalledWith("view-hidden", true);
  let resized!: () => void;
  vi.mocked(resizeBrowser).mockImplementationOnce(() => new Promise((resolve) => { resized = resolve; }));
  ref.current!.getBoundingClientRect = () => ({ x: 600, y: 100, width: 500, height: 600 }) as DOMRect;
  act(() => window.dispatchEvent(new Event("resize")));
  rerender({ suspended: true });
  await act(async () => { resized(); });
  expect(setBrowserVisible).not.toHaveBeenCalledWith("view-hidden", true);
});

it.each([
  { operation: "snapshot", includeScreenshot: false, captures: 0 },
  { operation: "snapshot", includeScreenshot: true, captures: 1 },
  { operation: "screenshot", includeScreenshot: false, captures: 1 },
])("captures native pixels only on explicit visual requests: $operation/$includeScreenshot", async ({ operation, includeScreenshot, captures }) => {
  const observation = {
    observationId: "visual-observation", documentId: "visual-document", tabId: "view-visual",
    url: "https://example.test/", readyState: "complete", items: [], textLines: [],
    viewport: { width: 500, height: 600, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 },
  };
  vi.mocked(evaluateBrowser).mockResolvedValue(JSON.stringify(JSON.stringify(observation)));
  renderHook(() => useBrowserPanel("https://example.test/", surface(), false, "view-visual", "browser-visual"));
  const response = await executeEmbeddedBrowserRequest("view-visual", operation, { nextObservationId: "visual-observation", includeScreenshot });
  expect(screenshotBrowser).toHaveBeenCalledTimes(captures);
  expect(response.result).toEqual(captures
      ? { ...observation, screenshotBase64: "native-png-base64" }
      : observation);
});

it("does not let an automation visibility request expose a suspended tab", async () => {
  vi.mocked(evaluateBrowser).mockResolvedValue(JSON.stringify(JSON.stringify({
    observationId: "observation-hidden", documentId: "document-hidden", url: "https://example.test/",
  })));
  renderHook(() => useBrowserPanel("https://example.test/", surface(), true, "view-hidden", "browser-hidden"));
  await executeEmbeddedBrowserRequest("view-hidden", "setVisible", { visible: true, nextObservationId: "observation-hidden" });
  expect(setBrowserVisible).not.toHaveBeenCalledWith("view-hidden", true);
});

it("queues a second navigation instead of silently dropping it while opening", async () => {
  let finish!: (value: { url: string }) => void;
  vi.mocked(openBrowser).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const ref = surface();
  const { result } = renderHook(() => useBrowserPanel("https://first.test/", ref, false, "view-queue"));
  let queued!: Promise<void>;
  act(() => { queued = result.current.load("https://second.test/"); });
  expect(openBrowser).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ url: "https://first.test/" });
    await queued;
  });
  expect(openBrowser).toHaveBeenCalledTimes(2);
  expect(openBrowser).toHaveBeenLastCalledWith("https://second.test/", expect.any(Object), "view-queue", false);
  expect(result.current.activeUrl).toBe("https://second.test/");
});

it("lets the agent observe a manual tab after native creation and delayed page readiness", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  let finish!: (value: { url: string }) => void;
  vi.mocked(openBrowser).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let page = {
    observationId: "adopted", documentId: "empty", tabId: "manual-view", url: "about:blank",
    readyState: "complete", items: [], textLines: [],
    viewport: { width: 500, height: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
  };
  vi.mocked(evaluateBrowser).mockImplementation(async () => JSON.stringify(JSON.stringify(page)));
  const ref = surface();
  renderHook(() => useBrowserPanel("https://manual.test/", ref, false, "manual-view"));
  const waiting = executeEmbeddedBrowserRequest("manual-view", "snapshot", { nextObservationId: "adopted" });
  const completed = vi.fn();
  void waiting.then(completed);
  expect(evaluateBrowser).not.toHaveBeenCalled();
  await act(async () => { finish({ url: "https://manual.test/" }); });
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(completed).not.toHaveBeenCalled();
  page = { ...page, documentId: "manual-document", url: "https://manual.test/" };
  await act(() => vi.advanceTimersByTimeAsync(500));
  await expect(waiting).resolves.toMatchObject({ result: { url: "https://manual.test/", documentId: "manual-document" } });
  expect(openBrowser).toHaveBeenCalledOnce();
});

it("does not reload a manual page when its observed URL metadata changes", async () => {
  const ref = surface();
  const { result, rerender } = renderHook(({ url }) => useBrowserPanel(url, ref, false, "manual-metadata"), {
    initialProps: { url: "https://example.test/login" },
  });
  await waitFor(() => expect(result.current.pending).toBe(false));
  rerender({ url: "https://example.test/account" });
  await act(async () => {});
  expect(openBrowser).toHaveBeenCalledOnce();
});

it("keeps native page ownership through StrictMode's immediate effect remount", async () => {
  const ref = surface();
  const { result, unmount } = renderHook(
    () => useBrowserPanel("https://example.test/", ref, false, "strict-view"),
    { wrapper: StrictMode },
  );
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(closeBrowser).not.toHaveBeenCalledWith("strict-view");
  expect(result.current.activeUrl).toBe("https://example.test/");
  unmount();
  await act(async () => {});
  expect(closeBrowser).toHaveBeenCalledWith("strict-view");
});

it.each([true, false])("retries explicit navigation when the old JS context disappears (cached identity: %s)", async (cached) => {
  vi.useFakeTimers();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  let page = {
    observationId: "retry-observation", documentId: "old-document", tabId: "retry-view", url: "https://old.test/",
    readyState: "complete", items: [], textLines: [],
    viewport: { width: 500, height: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
  };
  vi.mocked(evaluateBrowser).mockImplementation(async () => JSON.stringify(JSON.stringify(page)));
  vi.mocked(currentBrowser).mockImplementation(async () => ({ url: page.url }));
  const ref = surface();
  renderHook(() => useBrowserPanel(page.url, ref, false, "retry-view"));
  await act(async () => {});
  if (cached) {
    const observed = executeEmbeddedBrowserRequest("retry-view", "snapshot", { nextObservationId: "before-retry" });
    await act(() => vi.advanceTimersByTimeAsync(500));
    await observed;
  }
  vi.mocked(evaluateBrowser).mockRejectedValueOnce(new Error("JavaScript context is no longer available"));
  const retry = executeEmbeddedBrowserRequest("retry-view", "navigate", {
    url: "https://requested.test/", nextObservationId: "retry-observation",
  });
  const completed = vi.fn();
  void retry.then(completed);
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(openBrowser).toHaveBeenCalledTimes(2);
  expect(completed).not.toHaveBeenCalled();
  page = { ...page, documentId: "new-document", url: "https://redirected.test/" };
  await act(() => vi.advanceTimersByTimeAsync(500));
  await expect(retry).resolves.toMatchObject({ result: { url: "https://redirected.test/", documentId: "new-document" } });
});

it.each(["back", "forward", "reload"])("rejects stale observations before dispatching native %s", async (operation) => {
  vi.mocked(evaluateBrowser).mockImplementation(async (_viewId, script) => JSON.stringify(eval(script)));
  const ref = surface();
  renderHook(() => useBrowserPanel("https://example.test/", ref, false, "stale-history", "task-history"));
  await expect(executeEmbeddedBrowserRequest("stale-history", operation, {
    nextObservationId: "next-history", observationId: "stale-history",
    expectedObservation: {
      observationId: "stale-history", url: "https://previous.test/", documentId: "previous-document", tabId: "stale-history",
      viewport: { width: 900, height: 600, scrollX: 0, scrollY: 0 },
    },
  })).rejects.toThrow("stale observation");
  expect(browserAction).not.toHaveBeenCalled();
});

it("follows native page-load events for the loading indicator and address", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const ref = surface();
  const { result } = renderHook(() => useBrowserPanel("https://example.test/", ref));
  await waitFor(() => expect(result.current.pending).toBe(false));
  await waitFor(() => expect(nativeListeners.get("browser://page-load")?.size).toBe(1));
  const viewId = vi.mocked(openBrowser).mock.calls[0][2];
  // The IPC returned, but the page has not reported finishing yet.
  emitNative("browser://page-load", { viewId, url: "https://example.test/", phase: "started" });
  expect(result.current.loading).toBe(true);
  emitNative("browser://page-load", { viewId: "other-view", url: "https://other.test/", phase: "finished" });
  expect(result.current.loading).toBe(true);
  emitNative("browser://page-load", { viewId, url: "https://example.test/redirected", phase: "finished" });
  expect(result.current.loading).toBe(false);
  expect(result.current.activeUrl).toBe("https://example.test/redirected");
  emitNative("browser://page-load", { viewId, url: "https://example.test/next", phase: "started" });
  expect(result.current.loading).toBe(true);
});

it("keeps loading after a native reload until the page finishes", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const ref = surface();
  const { result } = renderHook(() => useBrowserPanel("https://example.test/", ref));
  await waitFor(() => expect(nativeListeners.get("browser://page-load")?.size).toBe(1));
  await waitFor(() => expect(result.current.pending).toBe(false));
  const viewId = vi.mocked(openBrowser).mock.calls[0][2];
  emitNative("browser://page-load", { viewId, url: "https://example.test/", phase: "finished" });
  expect(result.current.loading).toBe(false);
  vi.mocked(browserAction).mockImplementationOnce(async () => {
    nativeListeners.get("browser://page-load")?.forEach((handler) =>
      handler({ payload: { viewId, url: "https://example.test/", phase: "started" } }));
    return { url: "https://example.test/" };
  });
  await act(() => result.current.action("reload"));
  expect(result.current.pending).toBe(false);
  expect(result.current.loading).toBe(true);
  emitNative("browser://page-load", { viewId, url: "https://example.test/", phase: "finished" });
  expect(result.current.loading).toBe(false);
});

it("clears loading when a native action starts no page load", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  vi.mocked(openBrowser).mockResolvedValueOnce({ url: "https://example.test/" });
  const ref = surface();
  const { result } = renderHook(() => useBrowserPanel("https://example.test/", ref));
  await act(async () => {});
  expect(result.current.pending).toBe(false);
  emitNative("browser://page-load", { viewId: result.current.viewId, url: "https://example.test/", phase: "finished" });
  await act(() => result.current.action("back"));
  expect(result.current.loading).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(PAGE_LOAD_GRACE_MS));
  expect(result.current.loading).toBe(false);
  expect(result.current.loadError).toBeNull();
});

const refusedUrl = "http://127.0.0.1:1431/task-overview-preview.html";
const refused = { code: "NSURLErrorDomain:-1004", message: "Could not connect to the server." };

it.each([true, false])("retains a failed navigation arriving during dispatch: %s", async (duringDispatch) => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  let finish!: (value: { url: string }) => void;
  if (duringDispatch) vi.mocked(openBrowser).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useBrowserPanel(refusedUrl, surface(), false, "failed-view"));
  await waitFor(() => expect(nativeListeners.get("browser://page-load")?.size).toBe(1));
  emitNative("browser://page-load", { viewId: "failed-view", url: refusedUrl, phase: "started" });
  emitNative("browser://page-load", { viewId: "failed-view", url: refusedUrl, phase: "failed", error: refused });
  expect(result.current.loading).toBe(false);
  expect(result.current.loadError).toEqual({ url: refusedUrl, ...refused });
  await act(async () => { if (duringDispatch) finish({ url: refusedUrl }); });
  expect(result.current.loadError).toEqual({ url: refusedUrl, ...refused });
  expect(setBrowserVisible).toHaveBeenLastCalledWith("failed-view", false);
  expect(closeBrowser).not.toHaveBeenCalled();
  emitNative("browser://page-load", { viewId: "failed-view", url: refusedUrl, phase: "finished" });
  expect(result.current.loadError).toEqual({ url: refusedUrl, ...refused });
});

it("recovers a missed failed event from the first native poll", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  vi.mocked(currentBrowser).mockResolvedValueOnce({ url: refusedUrl, loadError: refused });
  const { result } = renderHook(() => useBrowserPanel(refusedUrl, surface(), false, "poll-error"));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(result.current.loading).toBe(false);
  expect(result.current.loadError).toEqual({ url: refusedUrl, ...refused });
  expect(setBrowserVisible).toHaveBeenLastCalledWith("poll-error", false);
});

it("ignores late old URL failures and successes after an explicit navigation", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const { result } = renderHook(() => useBrowserPanel(refusedUrl, surface(), false, "stale-events"));
  await waitFor(() => expect(result.current.pending).toBe(false));
  await waitFor(() => expect(nativeListeners.get("browser://page-load")?.size).toBe(1));
  await act(() => result.current.load("https://new.test/"));
  emitNative("browser://page-load", { viewId: "stale-events", url: "https://new.test/", phase: "started" });
  for (const phase of ["failed", "finished", "started"]) {
    emitNative("browser://page-load", { viewId: "stale-events", url: refusedUrl, phase, error: refused });
  }
  expect(result.current.loading).toBe(true);
  expect(result.current.loadError).toBeNull();
  expect(result.current.activeUrl).toBe("https://new.test/");
  emitNative("browser://page-load", { viewId: "stale-events", url: "https://new.test/", phase: "finished" });
  expect(result.current.loading).toBe(false);
  expect(result.current.loadError).toBeNull();
});

it("retries the original failed URL and restores the child while dispatching", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const { result } = renderHook(() => useBrowserPanel(refusedUrl, surface(), false, "retry-error"));
  await waitFor(() => expect(result.current.pending).toBe(false));
  await waitFor(() => expect(nativeListeners.get("browser://page-load")?.size).toBe(1));
  emitNative("browser://page-load", { viewId: "retry-error", url: refusedUrl, phase: "failed", error: refused });
  let finish!: (value: { url: string }) => void;
  vi.mocked(openBrowser).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let retry!: Promise<void>;
  await act(async () => { retry = result.current.action("reload"); });
  expect(result.current.loadError).toBeNull();
  expect(result.current.loading).toBe(true);
  expect(setBrowserVisible).toHaveBeenLastCalledWith("retry-error", true);
  expect(openBrowser).toHaveBeenLastCalledWith(refusedUrl, expect.any(Object), "retry-error", false);
  await act(async () => { finish({ url: refusedUrl }); await retry; });
  emitNative("browser://page-load", { viewId: "retry-error", url: refusedUrl, phase: "finished" });
  expect(result.current.loading).toBe(false);
  expect(result.current.loadError).toBeNull();
});

it("fails agent navigation promptly without exposing the previous DOM", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const { result } = renderHook(() => useBrowserPanel(refusedUrl, surface(), false, "agent-failure"));
  await waitFor(() => expect(result.current.pending).toBe(false));
  vi.mocked(currentBrowser)
    .mockResolvedValueOnce({ url: refusedUrl, loadError: refused })
    .mockResolvedValueOnce({ url: refusedUrl, loadError: refused });
  vi.mocked(evaluateBrowser).mockRejectedValueOnce(new Error("No old document"));
  await expect(executeEmbeddedBrowserRequest("agent-failure", "navigate", {
    url: refusedUrl,
    nextObservationId: "never-old-dom",
  })).rejects.toThrow(refused.code);
  expect(result.current.loadError?.url).toBe(refusedUrl);
});

it("handles a page link after the original navigation has completed", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const { result } = renderHook(() => useBrowserPanel("https://start.test/", surface(), false, "page-link"));
  await waitFor(() => expect(result.current.pending).toBe(false));
  await waitFor(() => expect(nativeListeners.get("browser://page-load")?.size).toBe(1));
  emitNative("browser://page-load", { viewId: "page-link", url: "https://start.test/", phase: "finished" });
  emitNative("browser://page-load", { viewId: "page-link", url: refusedUrl, phase: "started" });
  expect(result.current.loading).toBe(true);
  emitNative("browser://page-load", { viewId: "page-link", url: refusedUrl, phase: "failed", error: refused });
  expect(result.current.loading).toBe(false);
  expect(result.current.loadError?.url).toBe(refusedUrl);
});

it("keeps an old native page hidden if failure arrives during a resize", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  let finish!: () => void;
  vi.mocked(resizeBrowser).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useBrowserPanel(refusedUrl, surface(), false, "resize-failure"));
  await waitFor(() => expect(nativeListeners.get("browser://page-load")?.size).toBe(1));
  await waitFor(() => expect(resizeBrowser).toHaveBeenCalled());
  emitNative("browser://page-load", { viewId: "resize-failure", url: refusedUrl, phase: "failed", error: refused });
  await act(async () => { finish(); });
  expect(result.current.loadError?.url).toBe(refusedUrl);
  expect(setBrowserVisible).toHaveBeenLastCalledWith("resize-failure", false);
  vi.mocked(resizeBrowser).mockResolvedValue(undefined);
});

it("reports an explicit timeout even when no native load event arrives", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const { result } = renderHook(() => useBrowserPanel(refusedUrl, surface(), false, "timeout-error"));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(PAGE_LOAD_GRACE_MS));
  expect(result.current.loading).toBe(true);
  expect(result.current.loadError).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(PAGE_LOAD_SAFETY_MS - PAGE_LOAD_GRACE_MS));
  expect(result.current.loading).toBe(false);
  expect(result.current.loadError).toEqual({ url: refusedUrl, code: "NAVIGATION_TIMEOUT", message: "网页加载超时，请重试。" });
  expect(setBrowserVisible).toHaveBeenLastCalledWith("timeout-error", false);
});

it("caps the loading indicator when a finished event never arrives", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const ref = surface();
  const { result } = renderHook(() => useBrowserPanel("https://example.test/", ref));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(0));
  const viewId = vi.mocked(openBrowser).mock.calls[0][2];
  emitNative("browser://page-load", { viewId, url: "https://example.test/", phase: "started" });
  await act(() => vi.advanceTimersByTimeAsync(PAGE_LOAD_GRACE_MS * 2));
  expect(result.current.loading).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(PAGE_LOAD_SAFETY_MS));
  expect(result.current.loading).toBe(false);
});

it("records the zoom factor returned by zoom commands without navigating", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  const ref = surface();
  const { result } = renderHook(() => useBrowserPanel("https://example.test/", ref));
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.zoom).toBe(1);
  vi.mocked(browserAction).mockResolvedValueOnce({ url: "https://example.test/", zoom: 1.25 });
  await act(() => result.current.command("zoom_in"));
  expect(browserAction).toHaveBeenLastCalledWith("zoom_in", result.current.viewId);
  expect(result.current.zoom).toBe(1.25);
  expect(result.current.pending).toBe(false);
});

it("auto-loads an agent-owned popup tab but not a plain agent tab", async () => {
  const plain = renderHook(() => useBrowserPanel("https://agent.test/", surface(), false, "agent-view", "task-1"));
  await act(async () => {});
  expect(openBrowser).not.toHaveBeenCalled();
  plain.unmount();
  const popup = renderHook(() => useBrowserPanel("https://popup.test/", surface(), false, "popup-view", "task-1", true));
  await waitFor(() => expect(popup.result.current.pending).toBe(false));
  expect(openBrowser).toHaveBeenCalledWith("https://popup.test/", expect.any(Object), "popup-view", false);
});
