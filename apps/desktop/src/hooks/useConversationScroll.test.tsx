// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationScroll } from "./useConversationScroll";

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
  loadOlder?: () => void | Promise<void>;
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useConversationScroll", () => {
  it("keeps remote history manual and anchors each requested page without fetching the next one", async () => {
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

  it("stops stale automatic callbacks after switching to remote and resumes local scrolling", async () => {
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

  it("follows streaming content while pinned, and leaves a reader's position alone", () => {
    const { rerender } = render(<Harness hasOlder={false} />);
    const viewport = screen.getByTestId("viewport");
    expect(viewport.scrollTop).toBe(1200);
    rerender(<Harness hasOlder={false} tail={300} />);
    expect(viewport.scrollTop).toBe(1500);
    scrollTo(450);
    rerender(<Harness hasOlder={false} tail={600} />);
    expect(viewport.scrollTop).toBe(450);
    expect(screen.getByRole("button", { name: "Jump" })).toBeTruthy();
  });

  it("serializes intersect/scroll bursts and does not retry an unchanged failed cursor", async () => {
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
