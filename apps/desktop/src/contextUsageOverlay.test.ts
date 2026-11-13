// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeContextUsageOverlay,
  contextUsageOverlayBounds,
  listenContextUsageOverlayAction,
  openContextUsageOverlay,
  updateContextUsageOverlay,
} from "./contextUsageOverlay";

const native = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(),
  unlisten: vi.fn(),
  listener: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: native.listen.mockImplementation(async (_event: string, listener: (event: { payload: string }) => void) => {
    native.listener = listener;
    return native.unlisten;
  }),
}));

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

describe("contextUsageOverlayBounds", () => {
  it("positions the overlay above and aligned to the trigger", () => {
    expect(contextUsageOverlayBounds(rect(900, 700, 32, 32), 1200, 900)).toEqual({
      x: 560,
      y: 72,
      width: 372,
      height: 620,
    });
  });

  it("keeps the overlay inside a compact viewport", () => {
    expect(contextUsageOverlayBounds(rect(5, 5, 10, 10), 320, 480)).toEqual({
      x: 12,
      y: 12,
      width: 296,
      height: 456,
    });
  });

  it("never returns negative dimensions or out-of-bounds coordinates", () => {
    const bounds = contextUsageOverlayBounds(rect(0, 0, 1, 1), 10, 8);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(10);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(8);
  });
});

describe("context usage native bridge", () => {
  beforeEach(() => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.invoke.mockClear();
    native.listen.mockClear();
    native.unlisten.mockClear();
    native.listener = undefined;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses only the dedicated commands and preserves structured payloads", async () => {
    const bounds = { x: 10, y: 20, width: 300, height: 400 };
    const snapshot = { usage: null, loading: true, error: "暂不可用" };

    await expect(openContextUsageOverlay(bounds, snapshot)).resolves.toBe(true);
    await updateContextUsageOverlay(snapshot);
    await closeContextUsageOverlay();

    expect(native.invoke.mock.calls).toEqual([
      ["context_usage_overlay_open", { bounds, snapshot }],
      ["context_usage_overlay_update", { snapshot }],
      ["context_usage_overlay_close", {}],
    ]);
  });

  it("waits for an opening overlay before closing it", async () => {
    let finishOpen: (() => void) | undefined;
    native.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finishOpen = resolve; }));
    const bounds = { x: 10, y: 20, width: 300, height: 400 };
    const snapshot = { usage: null, loading: true, error: null };

    const opening = openContextUsageOverlay(bounds, snapshot);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
    const closing = closeContextUsageOverlay();
    await Promise.resolve();
    expect(native.invoke).toHaveBeenCalledOnce();

    finishOpen?.();
    await opening;
    await closing;
    expect(native.invoke.mock.calls).toEqual([
      ["context_usage_overlay_open", { bounds, snapshot }],
      ["context_usage_overlay_close", {}],
    ]);
  });

  it("filters native actions and stops dispatching after disposal", async () => {
    const handler = vi.fn();
    const dispose = listenContextUsageOverlayAction(handler);
    await vi.waitFor(() => expect(native.listener).toBeTypeOf("function"));

    native.listener?.({ payload: "open-external" });
    native.listener?.({ payload: "refresh" });
    native.listener?.({ payload: "close" });
    expect(handler.mock.calls).toEqual([["refresh"], ["close"]]);

    dispose();
    native.listener?.({ payload: "refresh" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(native.unlisten).toHaveBeenCalledOnce();
  });
});