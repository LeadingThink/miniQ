// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBrowserPanel } from "./useBrowserPanel";
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
import { resolveBrowserDriverRequest } from "../embeddedBrowserDriver";
import { isTauriRuntime } from "../runtime";
import type { RpcClient } from "../rpc";
import type { BrowserDriverRequest } from "../types";

vi.mock("../runtime", () => ({ isTauriRuntime: vi.fn(() => false) }));
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
  const call = vi.fn(async (
    _method: string,
    _params: Record<string, unknown>,
  ) => ({ resolved: true }));
  const client = { call } as unknown as RpcClient;
  const request = (id: string, operation: string, arguments_: Record<string, unknown>) => ({
    id,
    sessionId: "session-1",
    browserSessionId: "browser-session-1",
    operation,
    arguments: arguments_,
  }) satisfies BrowserDriverRequest;

  await resolveBrowserDriverRequest(client, request("open", "open", {
    url: "https://example.test/",
    nextObservationId: "observation-1",
  }));
  expect(call).toHaveBeenCalledWith("browser.resolve", expect.objectContaining({
    requestId: "open",
    result: expect.any(Object),
  }));
  const openResponse = call.mock.calls[0]?.[1] as {
    result: { result: Record<string, unknown> };
  };
  const observation = openResponse.result.result;
  expect(observation).toEqual(expect.objectContaining({
    observationId: "observation-1",
    tabId: "view-1",
  }));

  await resolveBrowserDriverRequest(client, request("click", "click", {
    nextObservationId: "observation-2",
    observationId: "observation-1",
    target: "rpa-observation-1-0",
    expectedObservation: observation,
  }));

  expect(call).toHaveBeenLastCalledWith("browser.resolve", expect.objectContaining({
    requestId: "click",
    result: expect.any(Object),
  }));
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
  const call = vi.fn(async (
    _method: string,
    _params: Record<string, unknown>,
  ) => ({ resolved: true }));
  const client = { call } as unknown as RpcClient;
  const request = (id: string, operation: string) => ({
    id,
    sessionId: "session-history",
    browserSessionId: "browser-history",
    operation,
    arguments: {
      nextObservationId: "stable-observation",
      observationId: "stable-observation",
      expectedObservation: {
        observationId: "stable-observation",
        url: "https://example.test/first",
        tabId: "view-history",
        documentId: "document-a",
        viewport: { width: 900, height: 600, scrollX: 0, scrollY: 0 },
      },
    },
  }) satisfies BrowserDriverRequest;

  await resolveBrowserDriverRequest(client, request("open", "open"));
  await resolveBrowserDriverRequest(client, request("back", "back"));

  expect(browserAction).toHaveBeenCalledWith("back", "view-history");
  expect(browserAction).toHaveBeenCalledTimes(1);
  const response = call.mock.calls.at(-1)?.[1] as {
    result?: { result?: Record<string, unknown> };
  };
  expect(response.result?.result).toEqual(expect.objectContaining({
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
  const call = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ resolved: true }));
  await resolveBrowserDriverRequest({ call } as unknown as RpcClient, {
    id: "visual-request", sessionId: "session-visual", browserSessionId: "browser-visual", operation,
    arguments: { nextObservationId: "visual-observation", includeScreenshot },
  });
  expect(screenshotBrowser).toHaveBeenCalledTimes(captures);
  expect(call).toHaveBeenCalledWith("browser.resolve", expect.objectContaining({
    result: expect.objectContaining({ result: captures
      ? { ...observation, screenshotBase64: "native-png-base64" }
      : observation }),
  }));
});

it("does not let an automation visibility request expose a suspended tab", async () => {
  vi.mocked(evaluateBrowser).mockResolvedValue(JSON.stringify(JSON.stringify({
    observationId: "observation-hidden", documentId: "document-hidden", url: "https://example.test/",
  })));
  renderHook(() => useBrowserPanel("https://example.test/", surface(), true, "view-hidden", "browser-hidden"));
  const call = vi.fn(async () => ({ resolved: true }));
  await resolveBrowserDriverRequest({ call } as unknown as RpcClient, {
    id: "visibility", sessionId: "session-hidden", browserSessionId: "browser-hidden",
    operation: "setVisible", arguments: { visible: true, nextObservationId: "observation-hidden" },
  });
  expect(setBrowserVisible).not.toHaveBeenCalledWith("view-hidden", true);
});
