// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { getKeepAwake, hasLocalRunningTasks, setKeepAwake, useKeepAwake, useKeepAwakePreference } from "./keepAwake";

const { invoke, runtime } = vi.hoisted(() => ({ invoke: vi.fn(), runtime: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./runtime", () => ({ isTauriRuntime: runtime }));

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  runtime.mockReturnValue(true);
  setKeepAwake(false);
});
afterEach(async () => {
  await act(async () => { cleanup(); });
  localStorage.clear();
  vi.restoreAllMocks();
});

it("persists the preference and notifies an active hook", () => {
  const hook = renderHook(useKeepAwakePreference);
  expect(hook.result.current.enabled).toBe(false);
  act(() => setKeepAwake(true));
  expect(getKeepAwake()).toBe(true);
  expect(hook.result.current.enabled).toBe(true);
});

it("defaults to disabled when there is no stored preference", () => {
  expect(getKeepAwake()).toBe(false);
});

it("holds only while enabled and busy, and releases on unmount", async () => {
  setKeepAwake(true);
  const hook = renderHook(({ busy }) => useKeepAwake(busy), { initialProps: { busy: true } });
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_keep_awake", { enabled: true }));
  hook.rerender({ busy: false });
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_keep_awake", { enabled: false }));
  hook.rerender({ busy: true });
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_keep_awake", { enabled: true }));
  hook.unmount();
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_keep_awake", { enabled: false }));
});

it("considers every local session and excludes remote viewers", () => {
  expect(hasLocalRunningTasks("local", [{ status: "idle" }, { status: "running" }])).toBe(true);
  expect(hasLocalRunningTasks("local", [{ status: "waiting_approval" }])).toBe(true);
  expect(hasLocalRunningTasks("local", [{ status: "cancelling" }])).toBe(true);
  expect(hasLocalRunningTasks("remote", [{ status: "running" }])).toBe(false);
  expect(hasLocalRunningTasks("local", [{ status: "failed" }])).toBe(false);
});

it("never calls native APIs from web or mobile", async () => {
  runtime.mockReturnValue(false);
  setKeepAwake(true);
  const hook = renderHook(() => useKeepAwake(true));
  await act(async () => { hook.unmount(); });
  expect(invoke).not.toHaveBeenCalled();
});

it("serializes disable after an unfinished enable", async () => {
  let finish!: () => void;
  invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  setKeepAwake(true);
  renderHook(() => useKeepAwake(true));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  act(() => setKeepAwake(false));
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_keep_awake", { enabled: false }));
});

it("exposes native and storage failures instead of claiming success", async () => {
  invoke.mockRejectedValueOnce(new Error("caffeinate unavailable"));
  setKeepAwake(true);
  const hook = renderHook(() => { useKeepAwake(true); return useKeepAwakePreference(); });
  await waitFor(() => expect(hook.result.current.error).toContain("caffeinate unavailable"));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  act(() => setKeepAwake(false));
  expect(hook.result.current.error).toContain("无法保存");
});
