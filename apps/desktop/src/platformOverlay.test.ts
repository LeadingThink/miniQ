// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closePlatformOverlay, listenPlatformOverlayAction, openPlatformOverlay, signalPlatformOverlayAction } from "./platformOverlay";

const native = vi.hoisted(() => ({ invoke: vi.fn(), off: vi.fn(), listen: vi.fn(), handler: undefined as ((event: { payload: string }) => void) | undefined }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
beforeEach(() => {
  vi.clearAllMocks();
  native.invoke.mockResolvedValue(undefined);
  native.listen.mockImplementation(async (_event, handler) => { native.handler = handler; return native.off; });
});
afterEach(() => { native.handler = undefined; });

it("sends each action through the dedicated native command without navigating the menu page", async () => {
  const originalUrl = window.location.href;
  for (const action of ["zaiwen", "miniq", "close"] as const) await signalPlatformOverlayAction(action);
  expect(native.invoke.mock.calls).toEqual([
    ["platform_overlay_action", { action: "zaiwen" }],
    ["platform_overlay_action", { action: "miniq" }],
    ["platform_overlay_action", { action: "close" }],
  ]);
  expect(window.location.href).toBe(originalUrl);
});

it("waits for an unfinished native attachment before dismissing it", async () => {
  let finish!: () => void;
  native.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const bounds = { x: 0, y: 0, width: 1200, height: 800 };
  const snapshot = { platform: "zaiwen" as const, requestId: "open", anchor: { left: 10, top: 0, bottom: 40, width: 120, height: 40 } };
  const opening = openPlatformOverlay(bounds, snapshot);
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
  const closing = closePlatformOverlay();
  await Promise.resolve();
  expect(native.invoke).toHaveBeenCalledOnce();
  finish();
  await opening;
  await closing;
  expect(native.invoke.mock.calls).toEqual([
    ["platform_overlay_open", { bounds, snapshot }], ["platform_overlay_close", {}],
  ]);
});

it("recovers the command queue after a failed open", async () => {
  native.invoke.mockRejectedValueOnce(new Error("failed"));
  await expect(closePlatformOverlay()).rejects.toThrow("failed");
  await expect(closePlatformOverlay()).resolves.toBeUndefined();
});

it("accepts only platform actions and disposes even a late subscription", async () => {
  let subscribe!: (off: () => void) => void;
  native.listen.mockImplementationOnce(async (_event, handler) => {
    native.handler = handler;
    return new Promise<() => void>((resolve) => { subscribe = resolve; });
  });
  const handler = vi.fn();
  const dispose = listenPlatformOverlayAction(handler);
  await vi.waitFor(() => expect(native.handler).toBeTypeOf("function"));
  for (const payload of ["zaiwen", "miniq", "close", "open-external"]) native.handler?.({ payload });
  expect(handler.mock.calls).toEqual([["zaiwen"], ["miniq"], ["close"]]);
  dispose();
  subscribe(native.off);
  await vi.waitFor(() => expect(native.off).toHaveBeenCalledOnce());
  native.handler?.({ payload: "miniq" });
  expect(handler).toHaveBeenCalledTimes(3);
});
