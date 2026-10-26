// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableHistoryError, useConversationScroll } from "./useConversationScroll";

const observers: IntersectionObserverCallback[] = [];
const resizeObservers: {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function Harness({
  viewKey = "session-a",
  cursorKey = "cursor-1",
  autoLoadOlder = true,
  hasOlder = true,
  loadingOlder = false,
  loading = false,
  prepend = 0,
  tail = 0,
  loadOlder = async () => {},
}: {
  viewKey?: string;
  cursorKey?: string | null;
  autoLoadOlder?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  loading?: boolean;
  prepend?: number;
  tail?: number;
  loadOlder?: () => void | { error: unknown } | Promise<void | { error: unknown }>;
}) {
  const scroll = useConversationScroll({
    viewKey, cursorKey, autoLoadOlder, hasOlder, loadingOlder, loading, loadOlder,
    contentVersion: `${prepend}:${tail}:${loading}`,
  });
  return <>
    <div data-testid="viewport" data-height={1200 + prepend + tail} ref={scroll.scrollRef} onScroll={scroll.onScroll}>
      <div ref={scroll.historyTopRef} />
      <div className="timeline-inner">
        {[0, 200, 400, 600, 800, 1000].map((offset) => (
          <div key={offset} data-history-anchor={`row-${offset}`} data-offset={offset + prepend}>Message {offset}</div>
        ))}
      </div>
    </div>
    <button onClick={scroll.loadOlder}>Load manually</button>
    <output data-testid="history-error">{scroll.historyError}</output>
    <output data-testid="retrying">{String(scroll.retryingOlder)}</output>
    {scroll.showJump && <button onClick={scroll.jumpToBottom}>Jump</button>}
  </>;
}

function intersect(callback = observers.at(-1)!) {
  act(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
}

function scrollTo(top: number) {
  const viewport = screen.getByTestId("viewport");
  viewport.scrollTop = top;
  fireEvent.scroll(viewport);
}

function resize(callback = resizeObservers.at(-1)!.callback) {
  act(() => callback([], {} as ResizeObserver));
}

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

beforeEach(() => {
  observers.length = 0;
  resizeObservers.length = 0;
  frames.clear();
  nextFrame = 0;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(callback: ResizeObserverCallback) {
      resizeObservers.push({ callback, observe: this.observe, disconnect: this.disconnect });
    }
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((frame: number) => frames.delete(frame)));
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return Number((this as HTMLElement).dataset.height ?? 0);
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const node = this as HTMLElement;
    const root = node.closest<HTMLElement>('[data-testid="viewport"]');
    const top = node.dataset.historyAnchor
      ? 100 + Number(node.dataset.offset) - (root?.scrollTop ?? 0)
      : 100;
    const height = node.dataset.historyAnchor ? 200 : 300;
    return { x: 0, y: top, top, bottom: top + height, left: 0, right: 400, width: 400, height, toJSON() {} };
  });
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useConversationScroll", () => {
  it("respects disabled automatic loading and anchors each requested page without fetching the next one", async () => {
    let resolve!: () => void;
    const loadOlder = vi.fn().mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }))
      .mockResolvedValue(undefined);
    const { rerender } = render(<Harness autoLoadOlder={false} loadOlder={loadOlder} />);
    scrollTo(40);
    scrollTo(0);
    resize();
    flushFrames();
    expect(observers).toHaveLength(0);
    expect(loadOlder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load manually" }));
    fireEvent.click(screen.getByRole("button", { name: "Load manually" }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
    scrollTo(50);
    await act(async () => { resolve(); });
    rerender(<Harness autoLoadOlder={false} loadOlder={loadOlder} cursorKey="cursor-2" prepend={600} tail={800} />);
    expect(screen.getByTestId("viewport").scrollTop).toBe(650);
    scrollTo(0);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load manually" })); });
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it("stops stale automatic callbacks after disabling auto loading and resumes when enabled", async () => {
    const loadOlder = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<Harness loadOlder={loadOlder} />);
    const staleObserver = observers.at(-1)!;
    rerender(<Harness autoLoadOlder={false} loadOlder={loadOlder} />);
    intersect(staleObserver);
    scrollTo(40);
    expect(loadOlder).not.toHaveBeenCalled();
    expect(observers).toHaveLength(1);
    rerender(<Harness loadOlder={loadOlder} />);
    await act(async () => { intersect(); });
    expect(loadOlder).toHaveBeenCalledTimes(1);
    intersect(staleObserver);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("coalesces font, image and viewport layout changes while following the bottom", () => {
    render(<Harness hasOlder={false} />);
    const viewport = screen.getByTestId("viewport");
    expect(resizeObservers[0].observe).toHaveBeenCalledWith(viewport);
    expect(resizeObservers[0].observe).toHaveBeenCalledWith(viewport.querySelector(".timeline-inner"));
    viewport.dataset.height = "1207";
    resize();
    resize();
    expect(frames.size).toBe(1);
    flushFrames();
    expect(viewport.scrollTop).toBe(1207);
    viewport.dataset.height = "1600";
    resize();
    flushFrames();
    expect(viewport.scrollTop).toBe(1600);
  });

  it("leaves a reader's position alone during layout changes, including a queued frame", () => {
    render(<Harness hasOlder={false} />);
    const viewport = screen.getByTestId("viewport");
    viewport.dataset.height = "1600";
    resize();
    scrollTo(450);
    flushFrames();
    expect(viewport.scrollTop).toBe(450);
    viewport.dataset.height = "2000";
    resize();
    expect(frames.size).toBe(0);
    expect(viewport.scrollTop).toBe(450);
  });

  it("cancels stale resize work when switching views or unmounting", () => {
    const { rerender, unmount } = render(<Harness hasOlder={false} />);
    const oldObserver = resizeObservers[0];
    resize();
    expect(frames.size).toBe(1);
    rerender(<Harness viewKey="session-b" hasOlder={false} tail={300} />);
    expect(oldObserver.disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    resize(oldObserver.callback);
    expect(frames.size).toBe(0);
    resize();
    unmount();
    expect(frames.size).toBe(0);
    expect(resizeObservers[1].disconnect).toHaveBeenCalledOnce();
  });

  it("follows streaming content once per frame while pinned, and leaves a reader's position alone", () => {
    const { rerender } = render(<Harness hasOlder={false} />);
    const viewport = screen.getByTestId("viewport");
    expect(viewport.scrollTop).toBe(1200);
    rerender(<Harness hasOlder={false} tail={100} />);
    rerender(<Harness hasOlder={false} tail={200} />);
    rerender(<Harness hasOlder={false} tail={300} />);
    expect(frames.size).toBe(1);
    flushFrames();
    expect(viewport.scrollTop).toBe(1500);
    rerender(<Harness hasOlder={false} tail={400} />);
    scrollTo(450);
    flushFrames();
    rerender(<Harness hasOlder={false} tail={600} />);
    flushFrames();
    expect(viewport.scrollTop).toBe(450);
    expect(screen.getByRole("button", { name: "Jump" })).toBeTruthy();
  });

  it("serializes intersect/scroll bursts and allows a manual retry to replace pending backoff", async () => {
    let reject!: (cause: Error) => void;
    const loadOlder = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }))
      .mockResolvedValue(undefined);
    const { rerender } = render(<Harness loadOlder={loadOlder} />);
    scrollTo(40);
    intersect();
    intersect();
    expect(loadOlder).toHaveBeenCalledTimes(1);
    rerender(<Harness loadOlder={loadOlder} loadingOlder />);
    await act(async () => { reject(new Error("network unavailable")); });
    rerender(<Harness loadOlder={loadOlder} />);
    intersect();
    scrollTo(30);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load manually" })); });
    expect(loadOlder).toHaveBeenCalledTimes(2);
    intersect();
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it("anchors a real row only when the history cursor advances, excluding concurrent stream append", async () => {
    const loadOlder = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<Harness loadOlder={loadOlder} />);
    await act(async () => { scrollTo(50); });
    const viewport = screen.getByTestId("viewport");
    rerender(<Harness loadOlder={loadOlder} loadingOlder tail={700} />);
    resize();
    flushFrames();
    expect(viewport.scrollTop).toBe(50);
    rerender(<Harness loadOlder={loadOlder} cursorKey="cursor-2" prepend={600} tail={1000} />);
    resize();
    flushFrames();
    expect(viewport.scrollTop).toBe(650);
    rerender(<Harness loadOlder={loadOlder} cursorKey="cursor-2" prepend={600} tail={1300} />);
    expect(viewport.scrollTop).toBe(650);
    intersect();
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it("preserves the reader's new position when they scroll during a pending page", async () => {
    const loadOlder = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<Harness loadOlder={loadOlder} />);
    await act(async () => { scrollTo(40); });
    rerender(<Harness loadOlder={loadOlder} loadingOlder />);
    scrollTo(450);
    rerender(<Harness loadOlder={loadOlder} cursorKey={null} hasOlder={false} prepend={600} tail={800} />);
    expect(screen.getByTestId("viewport").scrollTop).toBe(1050);
  });

  it("resets pinning, failed cursor suppression and pending anchors for another view", async () => {
    let resolve!: () => void;
    const loadOlder = vi.fn().mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }))
      .mockResolvedValue(undefined);
    const { rerender } = render(<Harness loadOlder={loadOlder} />);
    scrollTo(40);
    const staleObserver = observers.at(-1)!;
    rerender(<Harness viewKey="session-b:search" loadOlder={loadOlder} tail={400} />);
    expect(screen.getByTestId("viewport").scrollTop).toBe(1600);
    expect(screen.queryByRole("button", { name: "Jump" })).toBeNull();
    intersect(staleObserver);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
    scrollTo(30);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    rerender(<Harness viewKey="session-b:search" loadOlder={loadOlder} cursorKey="cursor-2" prepend={200} tail={400} />);
    expect(screen.getByTestId("viewport").scrollTop).toBe(230);
  });

  it("waits for initial loading and still auto pages without IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const loadOlder = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<Harness loadOlder={loadOlder} loading />);
    scrollTo(40);
    expect(loadOlder).not.toHaveBeenCalled();
    rerender(<Harness loadOlder={loadOlder} />);
    await act(async () => { scrollTo(40); });
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });
});

it("does not auto page on initial intersections or bottom-following scroll events", () => {
  const loadOlder = vi.fn();
  const { rerender } = render(<Harness loadOlder={loadOlder} />);
  intersect();
  scrollTo(900);
  intersect();
  rerender(<Harness loadOlder={loadOlder} tail={500} />);
  flushFrames();
  expect(loadOlder).not.toHaveBeenCalled();
  expect(screen.getByTestId("viewport").scrollTop).toBe(1700);
});

it("keeps following latest when a pending history page commits after an explicit jump", async () => {
  let resolve!: () => void;
  const loadOlder = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  const { rerender } = render(<Harness loadOlder={loadOlder} />);
  scrollTo(250);
  fireEvent.click(screen.getByRole("button", { name: "Jump" }));
  intersect();
  expect(loadOlder).toHaveBeenCalledTimes(1);
  rerender(<Harness loadOlder={loadOlder} cursorKey="cursor-2" prepend={600} tail={700} />);
  expect(screen.getByTestId("viewport").scrollTop).toBe(2500);
  expect(screen.queryByRole("button", { name: "Jump" })).toBeNull();
  // Let the jump settle on the now-stable bottom before the reader scrolls.
  while (frames.size) flushFrames();
  // A committed page must not release the in-flight lock prematurely.
  scrollTo(250);
  expect(loadOlder).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(); });
  await act(async () => { scrollTo(250); });
  expect(loadOlder).toHaveBeenCalledTimes(2);
});

it("retries transient failures after exactly 1, 2 and 4 seconds, then exposes a terminal error", async () => {
  vi.useFakeTimers();
  const loadOlder = vi.fn().mockResolvedValue({ error: new Error("network unavailable") });
  render(<Harness loadOlder={loadOlder} />);
  await act(async () => { scrollTo(40); });
  expect(screen.getByTestId("retrying").textContent).toBe("true");
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
    expect(loadOlder).toHaveBeenCalledTimes(index + 1);
    intersect();
    scrollTo(30);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(loadOlder).toHaveBeenCalledTimes(index + 2);
  }
  expect(screen.getByTestId("retrying").textContent).toBe("false");
  expect(screen.getByTestId("history-error").textContent).toBe("network unavailable");
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  intersect();
  expect(loadOlder).toHaveBeenCalledTimes(4);
});

it("preserves the reader's anchor across a thrown failure and successful retry", async () => {
  vi.useFakeTimers();
  const loadOlder = vi.fn().mockImplementationOnce(() => { throw new TypeError("Failed to fetch"); })
    .mockResolvedValue(undefined);
  const { rerender } = render(<Harness loadOlder={loadOlder} />);
  await act(async () => { scrollTo(40); });
  scrollTo(70);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(loadOlder).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("history-error").textContent).toBe("");
  expect(screen.getByTestId("retrying").textContent).toBe("false");
  rerender(<Harness loadOlder={loadOlder} cursorKey="cursor-2" prepend={600} tail={800} />);
  expect(screen.getByTestId("viewport").scrollTop).toBe(670);
});

it.each([
  { status: 401, message: "network authentication failed" },
  { status: 403, message: "temporarily forbidden" },
  new Error("invalid cursor"),
  new DOMException("network request aborted", "AbortError"),
  new Error("unknown failure"),
  { code: -32700, message: "network parse failure" },
  { code: -32600, message: "network request failure" },
  { code: -32601, message: "service unavailable" },
  { code: -32602, message: "temporary parameter failure" },
  { code: "-32602", message: "timeout" },
  { code: 401, message: "network failure" },
  { message: "auth required, temporarily unavailable" },
  { message: "unauthorized: network unavailable" },
  { message: "forbidden: connection failed" },
])("does not retry permanent or aborted failures: %s", async (error) => {
  vi.useFakeTimers();
  const loadOlder = vi.fn(() => ({ error }));
  render(<Harness loadOlder={loadOlder} />);
  await act(async () => { scrollTo(40); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(loadOlder).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("retrying").textContent).toBe("false");
  expect(screen.getByTestId("history-error").textContent).not.toBe("");
});

it("cancels backoff on view changes and unmount", async () => {
  vi.useFakeTimers();
  const loadOlder = vi.fn().mockRejectedValue(new Error("network offline"));
  const { rerender, unmount } = render(<Harness loadOlder={loadOlder} />);
  await act(async () => { scrollTo(40); });
  expect(vi.getTimerCount()).toBe(1);
  rerender(<Harness viewKey="session-b" loadOlder={loadOlder} />);
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.getByTestId("history-error").textContent).toBe("");
  expect(screen.getByTestId("retrying").textContent).toBe("false");
  await act(async () => { scrollTo(40); });
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(loadOlder).toHaveBeenCalledTimes(2);
});

it.each(["view", "unmount"])("ignores late rejected requests after %s cleanup", async (cleanupKind) => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const loadOlder = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  const { rerender, unmount } = render(<Harness loadOlder={loadOlder} />);
  scrollTo(40);
  if (cleanupKind === "view") rerender(<Harness viewKey="session-b" loadOlder={loadOlder} />);
  else unmount();
  await act(async () => { reject(new Error("network unavailable")); });
  expect(vi.getTimerCount()).toBe(0);
  expect(loadOlder).toHaveBeenCalledTimes(1);
  if (cleanupKind === "view") expect(screen.getByTestId("history-error").textContent).toBe("");
});

it.each(["wheel", "touch", "key"])("loads one short-viewport page on intentional %s navigation without observer chaining", async (kind) => {
  const loadOlder = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<Harness loadOlder={loadOlder} tail={-1000} />);
  const viewport = screen.getByTestId("viewport");
  scrollTo(0);
  intersect();
  fireEvent.wheel(viewport, { deltaY: 50 });
  fireEvent.keyDown(viewport, { key: "ArrowDown" });
  expect(loadOlder).not.toHaveBeenCalled();
  const navigate = () => {
    if (kind === "wheel") fireEvent.wheel(viewport, { deltaY: -50 });
    if (kind === "key") fireEvent.keyDown(viewport, { key: "PageUp" });
    if (kind === "touch") {
      fireEvent.touchStart(viewport, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(viewport, { touches: [{ clientY: 150 }] });
    }
  };
  await act(async () => { navigate(); });
  expect(loadOlder).toHaveBeenCalledTimes(1);
  rerender(<Harness loadOlder={loadOlder} cursorKey="cursor-2" prepend={100} tail={-1000} />);
  intersect();
  scrollTo(0);
  intersect();
  expect(loadOlder).toHaveBeenCalledTimes(1);
  await act(async () => { navigate(); });
  expect(loadOlder).toHaveBeenCalledTimes(2);
});

it.each([408, 429, 500, 502, 503, 504])("classifies temporary HTTP %s as retryable", (status) => {
  expect(isRetryableHistoryError({ status, message: "request failed" })).toBe(true);
});

it("pauses remaining backoff while offline without spending retry attempts", async () => {
  vi.useFakeTimers();
  const loadOlder = vi.fn().mockResolvedValue({ error: new Error("network unavailable") });
  render(<Harness loadOlder={loadOlder} />);
  await act(async () => { scrollTo(40); await vi.advanceTimersByTimeAsync(400); });
  fireEvent(window, new Event("offline"));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(loadOlder).toHaveBeenCalledTimes(1);
  fireEvent(window, new Event("online"));
  await act(async () => { await vi.advanceTimersByTimeAsync(599); });
  expect(loadOlder).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(loadOlder).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(loadOlder).toHaveBeenCalledTimes(4);
  expect(screen.getByTestId("retrying").textContent).toBe("false");
});

it("rearms exhausted transient history near the top on online, with another bounded cycle", async () => {
  vi.useFakeTimers();
  const loadOlder = vi.fn().mockResolvedValue({ error: new Error("network unavailable") });
  render(<Harness loadOlder={loadOlder} />);
  await act(async () => { scrollTo(40); await vi.advanceTimersByTimeAsync(7000); });
  expect(loadOlder).toHaveBeenCalledTimes(4);
  scrollTo(450);
  fireEvent(window, new Event("online"));
  expect(loadOlder).toHaveBeenCalledTimes(4);
  scrollTo(40);
  expect(loadOlder).toHaveBeenCalledTimes(4);
  await act(async () => { fireEvent(window, new Event("online")); });
  expect(loadOlder).toHaveBeenCalledTimes(5);
  fireEvent(window, new Event("online"));
  expect(loadOlder).toHaveBeenCalledTimes(5);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(loadOlder).toHaveBeenCalledTimes(8);
  expect(screen.getByTestId("retrying").textContent).toBe("false");
});

it("keeps landing on the bottom after a jump while late layout grows the transcript", () => {
  render(<Harness />);
  const viewport = screen.getByTestId("viewport");
  scrollTo(250);
  fireEvent.click(screen.getByRole("button", { name: "Jump" }));
  expect(viewport.scrollTop).toBe(1200);
  // Remounted windowed turns or images grow the transcript after the jump.
  viewport.dataset.height = "1900";
  flushFrames();
  expect(viewport.scrollTop).toBe(1900);
  flushFrames();
  flushFrames();
  expect(frames.size).toBe(0);
  expect(screen.queryByRole("button", { name: "Jump" })).toBeNull();
});

it("stops settling at the bottom as soon as the reader scrolls away", () => {
  render(<Harness />);
  const viewport = screen.getByTestId("viewport");
  scrollTo(250);
  fireEvent.click(screen.getByRole("button", { name: "Jump" }));
  fireEvent.wheel(viewport, { deltaY: -120 });
  viewport.dataset.height = "1900";
  flushFrames();
  expect(viewport.scrollTop).toBe(1200);
});

it("never rearms permanent failures on online", async () => {
  vi.useFakeTimers();
  const loadOlder = vi.fn().mockResolvedValue({ error: { code: -32602, message: "invalid cursor" } });
  render(<Harness loadOlder={loadOlder} />);
  await act(async () => { scrollTo(40); });
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it.each(["paused", "exhausted"])("discards %s recovery on view change and unmount", async (state) => {
  vi.useFakeTimers();
  const loadOlder = vi.fn().mockResolvedValue({ error: new Error("network unavailable") });
  const { rerender, unmount } = render(<Harness loadOlder={loadOlder} />);
  await act(async () => { scrollTo(40); await vi.advanceTimersByTimeAsync(state === "exhausted" ? 7000 : 400); });
  const count = loadOlder.mock.calls.length;
  fireEvent(window, new Event("offline"));
  rerender(<Harness viewKey="session-b" loadOlder={loadOlder} />);
  scrollTo(40);
  fireEvent(window, new Event("online"));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(loadOlder).toHaveBeenCalledTimes(count);
  await act(async () => { scrollTo(40); });
  fireEvent(window, new Event("offline"));
  unmount();
  fireEvent(window, new Event("online"));
  await vi.advanceTimersByTimeAsync(60000);
  expect(loadOlder).toHaveBeenCalledTimes(count + 1);
  expect(vi.getTimerCount()).toBe(0);
});
