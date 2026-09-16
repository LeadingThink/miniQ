// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDaemonConnection } from "./useDaemonConnection";
import type { RpcClient } from "../rpc";

const resolveConnection = vi.hoisted(() => vi.fn());
vi.mock("../rpc", () => ({ resolveConnection }));
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
