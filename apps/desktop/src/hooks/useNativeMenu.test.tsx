// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNativeMenu } from "./useNativeMenu";

const native = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: native.create } }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function anchor() {
  const element = document.createElement("button");
  element.getBoundingClientRect = () => ({ left: 92, bottom: 44 }) as DOMRect;
  return element;
}

it("anchors a popup below its trigger and retains actions after popup resolves", async () => {
  const first = { popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  const second = { popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  native.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const onError = vi.fn();
  const { result, unmount } = renderHook(() => useNativeMenu(onError));
  await act(() => result.current({ items: [{ text: "miniQ" }] }, anchor()));
  expect(first.popup).toHaveBeenCalledWith(expect.objectContaining({ x: 92, y: 44 }));
  expect(first.close).not.toHaveBeenCalled();
  await act(() => result.current({ items: [{ text: "在问" }] }, anchor()));
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.popup).toHaveBeenCalledOnce();
  unmount();
  expect(second.close).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it("disposes a late-created menu without opening it after unmount", async () => {
  const menu = { popup: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  let finish!: (value: typeof menu) => void;
  native.create.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const onError = vi.fn();
  const { result, unmount } = renderHook(() => useNativeMenu(onError));
  let opening!: Promise<void>;
  await act(async () => { opening = result.current({}, anchor()); });
  unmount();
  await act(async () => { finish(menu); await opening; });
  expect(menu.close).toHaveBeenCalledOnce();
  expect(menu.popup).not.toHaveBeenCalled();
});

it("reports a popup failure and allows a subsequent attempt", async () => {
  const menu = { popup: vi.fn().mockRejectedValueOnce("popup failed").mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  native.create.mockResolvedValue(menu);
  const onError = vi.fn();
  const { result } = renderHook(() => useNativeMenu(onError));
  await act(() => result.current({}, anchor()));
  expect(onError).toHaveBeenCalledWith("无法打开菜单：popup failed");
  await act(() => result.current({}, anchor()));
  expect(menu.popup).toHaveBeenCalledTimes(2);
});
