// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDaemonConnection } from "./useDaemonConnection";
import type { RpcClient } from "../rpc";

const resolveConnection = vi.hoisted(() => vi.fn());
const mobile = vi.hoisted(() => ({ active: null as null | ((state: { isActive: boolean }) => void) }));
vi.mock("../rpc", () => ({ resolveConnection }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn((_event, callback) => {
  mobile.active = callback;
  return Promise.resolve({ remove: vi.fn() });
}) } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("discards an in-flight connection lookup when installation pauses reconnect", async () => {
  let finish!: (value: unknown) => void;
  resolveConnection.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  resolveConnection.mockResolvedValue({ kind: "local", port: 1234, token: "test" });
  const client = {
    connected: true, connect: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockResolvedValue({}), onStatus: () => () => {}, onResync: () => () => {}, onEvent: () => () => {},
  } as unknown as RpcClient;
  const refresh = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const hook = renderHook(({ paused }) => useDaemonConnection({
    client, paused, refreshWorkspaces: refresh, refreshSessions: refresh, onError,
  }), { initialProps: { paused: false } });
  hook.rerender({ paused: true });
  await act(async () => { finish({ kind: "local", port: 1234, token: "test" }); });
  expect(client.connect).not.toHaveBeenCalled();
  hook.rerender({ paused: false });
  await waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
});

it("tracks whether a provider key is configured and refreshes it after settings change", async () => {
  resolveConnection.mockResolvedValue({ kind: "local", port: 1234, token: "test" });
  let hasApiKey = false;
  const client = {
    connected: true,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    call: vi.fn().mockImplementation((method: string) => {
      if (method === "daemon.health") return Promise.resolve({ daemonVersion: "test" });
      if (method === "settings.get") return Promise.resolve({ provider: { hasApiKey } });
      return Promise.resolve({});
    }),
    onStatus: () => () => {},
    onResync: () => () => {},
    onEvent: () => () => {},
  } as unknown as RpcClient;
  const refresh = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const hook = renderHook(() => useDaemonConnection({
    client,
    refreshWorkspaces: refresh,
    refreshSessions: refresh,
    onError,
  }));

  await waitFor(() => expect(hook.result.current.connectionEpoch).toBe(1));
  expect(hook.result.current.providerConfigured).toBe(false);
  hasApiKey = true;
  await act(async () => {
    await expect(hook.result.current.refreshProviderConfiguration()).resolves.toBe(true);
  });
  expect(hook.result.current.providerConfigured).toBe(true);
});

it("deduplicates foreground probes and preserves a healthy socket when catalog sync fails", async () => {
  resolveConnection.mockResolvedValue({ kind: "remote", url: "wss://example.test" });
  let finishProbe!: (value: unknown) => void;
  const call = vi.fn().mockResolvedValue({});
  const client = { connected: true, call, connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    onStatus: () => () => {}, onResync: () => () => {}, onEvent: () => () => {},
  } as unknown as RpcClient;
  const refreshWorkspaces = vi.fn().mockResolvedValue(undefined);
  const refreshSessions = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const hook = renderHook(() => useDaemonConnection({ client, refreshWorkspaces, refreshSessions, onError }));
  await waitFor(() => expect(hook.result.current.connectionEpoch).toBe(1));
  call.mockClear();
  call.mockImplementationOnce(() => new Promise((resolve) => { finishProbe = resolve; }));
  refreshSessions.mockRejectedValueOnce(new Error("catalog unavailable"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  act(() => {
    mobile.active?.({ isActive: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(call).toHaveBeenCalledTimes(1);
  await act(async () => finishProbe({ daemonVersion: "latest" }));
  await waitFor(() => expect(hook.result.current.connectionEpoch).toBe(2));
  expect(client.disconnect).not.toHaveBeenCalled();
  expect(client.connect).toHaveBeenCalledTimes(1);
  expect(refreshSessions).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenLastCalledWith("同步失败：catalog unavailable");
  expect(hook.result.current.health?.daemonVersion).toBe("latest");
});
