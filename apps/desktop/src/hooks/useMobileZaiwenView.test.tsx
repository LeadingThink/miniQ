// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileZaiwenState } from "../mobileZaiwen";

const native = vi.hoisted(() => ({ update: vi.fn(), read: vi.fn(), reload: vi.fn() }));
vi.mock("../mobileZaiwen", () => ({
  mobileZaiwenCapabilities: () => ({ embeddedView: true }),
  updateMobileZaiwen: native.update, readMobileZaiwenState: native.read, reloadMobileZaiwen: native.reload,
}));
import { useMobileZaiwenView } from "./useMobileZaiwenView";

const ready: MobileZaiwenState = { loading: false, canGoBack: false, error: null };
let hidden = false;
let resize: ResizeObserverCallback;
const bounds = { left: 0, top: 64, width: 390, height: 720 } as DOMRect;
const surface = { current: { getBoundingClientRect: () => bounds } as HTMLElement };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {}
  });
  native.update.mockResolvedValue(ready);
  native.read.mockResolvedValue(ready);
  native.reload.mockResolvedValue(ready);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("hides for backgrounding and reapplies current bounds after rotation and foregrounding", async () => {
  const rect = { ...bounds };
  const ref = { current: { getBoundingClientRect: () => rect } as HTMLElement };
  renderHook(() => useMobileZaiwenView(ref, true));
  await act(async () => {});
  hidden = true;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(native.update).toHaveBeenLastCalledWith({ visible: false });
  hidden = false; rect.width = 780; rect.height = 320;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(native.update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, width: 780, height: 320 }));
  rect.height = 250;
  await act(async () => { resize([], {} as ResizeObserver); });
  expect(native.update).toHaveBeenLastCalledWith(expect.objectContaining({ height: 250 }));
});

it("keeps a native creation failure visible and recreates its geometry before retrying", async () => {
  native.update.mockRejectedValueOnce(new Error("missing native asset"));
  const { result } = renderHook(() => useMobileZaiwenView(surface, true));
  await act(async () => {});
  expect(result.current.error).toContain("重试");
  expect(native.update).toHaveBeenLastCalledWith({ visible: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result.current.error).toContain("重试");
  native.update.mockClear();
  await act(async () => { await result.current.retry(); });
  expect(native.update).toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
  expect(native.update.mock.invocationCallOrder[0]).toBeLessThan(native.reload.mock.invocationCallOrder[0]);
  expect(result.current.error).toBeNull();
});

it("ignores a late state response after switching away and stops polling", async () => {
  const response = deferred<MobileZaiwenState>();
  native.read.mockReturnValueOnce(response.promise);
  const { result, rerender } = renderHook(({ active }) => useMobileZaiwenView(surface, active), { initialProps: { active: true } });
  await act(async () => {});
  rerender({ active: false });
  await act(async () => { response.resolve({ ...ready, error: "迟到的错误" }); });
  expect(result.current.error).toBeNull();
  expect(native.update).toHaveBeenLastCalledWith({ visible: false });
  const calls = native.read.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(native.read).toHaveBeenCalledTimes(calls);
});

it("does not reload a view when retry setup finishes after unmount", async () => {
  const { result, unmount } = renderHook(() => useMobileZaiwenView(surface, true));
  await act(async () => {});
  const response = deferred<MobileZaiwenState>();
  native.update.mockReturnValueOnce(response.promise);
  let retry!: Promise<void>;
  act(() => { retry = result.current.retry(); });
  unmount();
  await act(async () => { response.resolve(ready); await retry; });
  expect(native.reload).not.toHaveBeenCalled();
  expect(native.update).toHaveBeenLastCalledWith({ visible: false });
});
