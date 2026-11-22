// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";

const mocks = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), keys: vi.fn() }));
vi.mock("../zaiwenKeyImport", async (original) => ({ ...(await original<typeof import("../zaiwenKeyImport")>()),
  zaiwenSessionStatus: mocks.status, importZaiwenKey: mocks.save, loadZaiwenImportKeys: mocks.keys,
}));
import { useZaiwenKeyImport } from "./useZaiwenKeyImport";

const provider = { baseUrl: "https://other.test/v1", model: "custom", hasApiKey: false };
const key = { key_id: "first", sk: "sk-first-fixture", remark: "First", is_active: true, expire_time: 4102444800 };
const second = { ...key, key_id: "second", sk: "sk-second-fixture" };
const client = { mode: "local", call: vi.fn() } as unknown as RpcClient;
beforeEach(() => {
  vi.resetAllMocks(); mocks.status.mockResolvedValue({ supported: true, sessionId: "session-a" });
  vi.mocked(client.call).mockResolvedValue({ provider });
  mocks.keys.mockResolvedValue([key]); mocks.save.mockResolvedValue(key);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("opens the key list after login, with no consent step or automatic save even for a single key", async () => {
  const { result, rerender } = renderHook(({ active }) => useZaiwenKeyImport(active, active, client), { initialProps: { active: false } });
  expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.keys).not.toHaveBeenCalled();
  rerender({ active: true });
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  await act(async () => { await result.current.confirm(); });
  expect(mocks.save).not.toHaveBeenCalled();
  act(() => result.current.selectKey("first"));
  await act(async () => { await result.current.confirm(); });
  expect(mocks.save).toHaveBeenCalledWith(client, "session-a", expect.any(AbortSignal), "first");
  expect(result.current.prompt).toBeNull(); expect(result.current.configured).toBe(true);
});

it("detects login without a page reload and does not reopen a dismissed picker automatically", async () => {
  vi.useFakeTimers(); mocks.status.mockResolvedValue({ supported: true, sessionId: null });
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await act(async () => {});
  expect(result.current.prompt).toBeNull(); expect(mocks.keys).not.toHaveBeenCalled();
  mocks.status.mockResolvedValue({ supported: true, sessionId: "session-a" });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(result.current.prompt?.keys).toEqual([key]);
  act(() => result.current.dismiss());
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(result.current.prompt).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => { await result.current.request(); });
  expect(result.current.prompt?.keys).toEqual([key]);
});

it("reloads the picker for a different account", async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await act(async () => {});
  act(() => result.current.dismiss());
  mocks.status.mockResolvedValue({ supported: true, sessionId: "session-b" });
  mocks.keys.mockResolvedValue([second]);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(result.current.prompt?.sessionId).toBe("session-b");
  expect(result.current.prompt?.keys).toEqual([second]);
});

it("aborts saving when the chooser is deactivated and ignores a late result", async () => {
  let finish!: () => void;
  mocks.save.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { result, rerender } = renderHook(({ active }) => useZaiwenKeyImport(active, active, client), { initialProps: { active: true } });
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  act(() => result.current.selectKey("first"));
  let saving!: Promise<void>;
  act(() => { saving = result.current.confirm(); });
  const signal = mocks.save.mock.calls[0][2] as AbortSignal;
  rerender({ active: false });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(); await saving; });
  expect(result.current.configured).toBe(false);

});

it("requires an explicit selection and saves precisely the chosen ID", async () => {
  mocks.keys.mockResolvedValue([key, second]);
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key, second]));
  expect(result.current.prompt?.selectedKeyId).toBeNull();
  await act(async () => { await result.current.confirm(); });
  expect(mocks.save).not.toHaveBeenCalled();
  act(() => result.current.selectKey("second"));
  await act(async () => { await result.current.confirm(); });
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(client, "session-a", expect.any(AbortSignal), "second");
  expect(mocks.keys).toHaveBeenCalledOnce();
});

it("does not save when a user cancels the chooser", async () => {
  mocks.keys.mockResolvedValue([key, second]);
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key, second]));
  act(() => result.current.dismiss());
  expect(result.current.prompt).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
});

it("requests creation only after confirmation when no usable key exists", async () => {
  mocks.keys.mockResolvedValue([{ ...key, is_active: false }]);
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.prompt?.keys).toHaveLength(1));
  expect(mocks.save).not.toHaveBeenCalled();
  act(() => result.current.selectKey("first"));
  expect(result.current.prompt?.selectedKeyId).toBeNull();
  await act(async () => { await result.current.confirm(); });
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(client, "session-a", expect.any(AbortSignal), null);
});

it("keeps configured credentials and leaves replacement to model settings", async () => {
  const configured = { ...provider, baseUrl: "https://oneapi.zaiwenai.com/v1/", hasApiKey: true };
  vi.mocked(client.call).mockResolvedValue({ provider: configured });
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.configured).toBe(true));
  expect(result.current.prompt).toBeNull(); expect(mocks.keys).not.toHaveBeenCalled();
  await act(async () => { await result.current.request(); });
  expect(result.current.prompt).toBeNull();
  expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

it("detects a configured key before the main-site account has logged in", async () => {
  mocks.status.mockResolvedValue({ supported: true, sessionId: null });
  vi.mocked(client.call).mockResolvedValue({ provider: { ...provider, baseUrl: "https://oneapi.zaiwenai.com/v1", hasApiKey: true } });
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.configured).toBe(true));
  expect(result.current.prompt).toBeNull();
  expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

it("reopens the picker on re-entry when the previous choice was cancelled without configuring a key", async () => {
  vi.mocked(client.call).mockResolvedValue({ provider: null });
  const { result, rerender } = renderHook(({ active }) => useZaiwenKeyImport(active, active, client), { initialProps: { active: true } });
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  act(() => result.current.dismiss());
  rerender({ active: false }); rerender({ active: true });
  await waitFor(() => expect(mocks.keys).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  expect(result.current.configured).toBe(false); expect(result.current.prompt?.selectedKeyId).toBeNull();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("rechecks settings on re-entry and prompts if a previously configured key was removed", async () => {
  const configured = { ...provider, baseUrl: "https://oneapi.zaiwenai.com/v1", hasApiKey: true };
  vi.mocked(client.call).mockResolvedValue({ provider: configured });
  const { result, rerender } = renderHook(({ active }) => useZaiwenKeyImport(active, active, client), { initialProps: { active: true } });
  await waitFor(() => expect(result.current.configured).toBe(true));
  rerender({ active: false });
  vi.mocked(client.call).mockResolvedValue({ provider: { ...configured, hasApiKey: false } });
  rerender({ active: true });
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  expect(result.current.configured).toBe(false); expect(mocks.save).not.toHaveBeenCalled();
});

it("stops prompting after the chosen key is saved to miniQ", async () => {
  const { result, rerender } = renderHook(({ active }) => useZaiwenKeyImport(active, active, client), { initialProps: { active: true } });
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  act(() => result.current.selectKey("first"));
  mocks.save.mockImplementation(async () => {
    vi.mocked(client.call).mockResolvedValue({ provider: { ...provider, hasApiKey: true } });
  });
  await act(async () => { await result.current.confirm(); });
  expect(result.current.configured).toBe(true);
  rerender({ active: false }); rerender({ active: true });
  await act(async () => {});
  expect(result.current.prompt).toBeNull(); expect(mocks.keys).toHaveBeenCalledOnce();
});

it("prepares the chooser on the site but only loads keys when returning to miniQ", async () => {
  const { result, rerender } = renderHook(({ show }) => useZaiwenKeyImport(true, show, client), { initialProps: { show: false } });
  await waitFor(() => expect(result.current.prompt?.sessionId).toBe("session-a"));
  expect(result.current.prompt?.keys).toBeNull(); expect(mocks.keys).not.toHaveBeenCalled();
  rerender({ show: true });
  expect(result.current.prompt).not.toBeNull();
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
});

it("clears a prepared chooser if the user logs out before switching", async () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ show }) => useZaiwenKeyImport(true, show, client), { initialProps: { show: false } });
  await act(async () => {});
  expect(result.current.prompt?.sessionId).toBe("session-a");
  mocks.status.mockResolvedValue({ supported: true, sessionId: null });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(result.current.prompt).toBeNull();
  rerender({ show: true });
  await act(async () => {});
  expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

it("opens the picker for an official endpoint with no saved key", async () => {
  vi.mocked(client.call).mockResolvedValue({ provider: { ...provider, baseUrl: "https://oneapi.zaiwenai.com/v1", hasApiKey: false } });
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  expect(result.current.configured).toBe(false);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("ignores a late list after leaving the site", async () => {
  let finish!: (keys: typeof key[]) => void;
  mocks.keys.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result, rerender } = renderHook(({ active }) => useZaiwenKeyImport(active, active, client), { initialProps: { active: true } });
  await waitFor(() => expect(mocks.keys).toHaveBeenCalledOnce());
  const signal = mocks.keys.mock.calls[0][2] as AbortSignal;
  rerender({ active: false });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish([key, second]); });
  expect(result.current.prompt).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
});

it("keeps polling during list loading and aborts it when the account changes", async () => {
  vi.useFakeTimers();
  let finish!: (keys: typeof key[]) => void;
  mocks.keys.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue([second]);
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await act(async () => {});
  const signal = mocks.keys.mock.calls[0][2] as AbortSignal;
  mocks.status.mockResolvedValue({ supported: true, sessionId: "session-b" });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish([key]); });
  expect(result.current.prompt?.sessionId).toBe("session-b");
  expect(result.current.prompt?.keys).toEqual([second]); expect(mocks.save).not.toHaveBeenCalled();
});

it("reports unsupported capabilities without accessing account keys", async () => {
  mocks.status.mockResolvedValue({ supported: false, sessionId: null });
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.message).toContain("尚不支持"));
  expect(result.current.prompt).toBeNull(); expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

it("reports selection failures and allows the chosen key to be retried", async () => {
  mocks.save.mockRejectedValueOnce(new Error("保存失败"));
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  act(() => result.current.selectKey("first"));
  await act(async () => { await result.current.confirm(); });
  expect(result.current.message).toBe("保存失败");
  await act(async () => { await result.current.confirm(); });
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(result.current.configured).toBe(true);
});

it("shows list failures and supports retry without writing settings", async () => {
  mocks.keys.mockRejectedValueOnce(new Error("SSO 暂不可用"));
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await waitFor(() => expect(result.current.message).toBe("SSO 暂不可用"));
  expect(result.current.prompt?.keys).toBeNull();
  await act(async () => { await result.current.request(); });
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([key]));
  expect(mocks.save).not.toHaveBeenCalled();
});

it("honors cancellation while rechecking a prepared chooser on return to miniQ", async () => {
  const { result, rerender } = renderHook(({ show }) => useZaiwenKeyImport(true, show, client), { initialProps: { show: false } });
  await waitFor(() => expect(result.current.prompt?.sessionId).toBe("session-a"));
  let finish!: (value: { supported: boolean; sessionId: string }) => void;
  mocks.status.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  rerender({ show: true });
  act(() => result.current.dismiss());
  await act(async () => finish({ supported: true, sessionId: "session-a" }));
  expect(result.current.prompt).toBeNull();
  expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

it("aborts key loading when switching to the site and ignores its late result after re-entry", async () => {
  let finish!: (keys: typeof key[]) => void;
  mocks.keys.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result, rerender } = renderHook(({ show }) => useZaiwenKeyImport(true, show, client), { initialProps: { show: true } });
  await waitFor(() => expect(mocks.keys).toHaveBeenCalledOnce());
  const signal = mocks.keys.mock.calls[0][2] as AbortSignal;
  rerender({ show: false });
  expect(signal.aborted).toBe(true);
  mocks.keys.mockResolvedValue([second]);
  rerender({ show: true });
  await waitFor(() => expect(result.current.prompt?.keys).toEqual([second]));
  await act(async () => finish([key]));
  expect(result.current.prompt?.keys).toEqual([second]);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("discards an in-flight key list if miniQ is configured elsewhere", async () => {
  vi.useFakeTimers();
  let finish!: (keys: typeof key[]) => void;
  mocks.keys.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useZaiwenKeyImport(true, true, client));
  await act(async () => {});
  const signal = mocks.keys.mock.calls[0][2] as AbortSignal;
  vi.mocked(client.call).mockResolvedValue({ provider: { ...provider, hasApiKey: true } });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(signal.aborted).toBe(true);
  expect(result.current.configured).toBe(true);
  expect(result.current.prompt).toBeNull();
  await act(async () => finish([key]));
  expect(result.current.prompt).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
});
