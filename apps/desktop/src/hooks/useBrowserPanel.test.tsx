// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBrowserPanel } from "./useBrowserPanel";
import {
  closeBrowser,
  currentBrowser,
  openBrowser,
  resizeBrowser,
  setBrowserVisible,
} from "../browserWorkbench";
import { isTauriRuntime } from "../runtime";

vi.mock("../runtime", () => ({ isTauriRuntime: vi.fn(() => false) }));
vi.mock("../browserWorkbench", async (original) => ({
  ...(await original<typeof import("../browserWorkbench")>()),
  openBrowser: vi.fn(async (url: string) => ({ url })),
  closeBrowser: vi.fn(async () => {}),
  resizeBrowser: vi.fn(async () => {}),
  setBrowserVisible: vi.fn(async () => {}),
  currentBrowser: vi.fn(async () => null),
  browserAction: vi.fn(async () => null),
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
  expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, true);
  expect(openBrowser).toHaveBeenCalledTimes(1);
});
