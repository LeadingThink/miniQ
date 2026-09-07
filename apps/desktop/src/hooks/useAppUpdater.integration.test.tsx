// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { useAppUpdater } from "./useAppUpdater";
import { useDaemonConnection } from "./useDaemonConnection";

const fake = vi.hoisted(() => ({
  invoke: vi.fn(), check: vi.fn(), download: vi.fn(), install: vi.fn(),
  relaunch: vi.fn(), resolveConnection: vi.fn(), close: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: fake.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: fake.relaunch }));
vi.mock("../rpc", () => ({ resolveConnection: fake.resolveConnection }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DEV", false);
  fake.resolveConnection.mockResolvedValue({ kind: "local", port: 1234, token: "test" });
  fake.check.mockResolvedValue({ version: "0.1.16", download: fake.download, install: fake.install, close: fake.close });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

function setup() {
  const listeners = new Set<(connected: boolean) => void>();
  const client = {
    connected: true,
    connect: vi.fn().mockImplementation(async () => { client.connected = true; }),
    onStatus: (listener: (connected: boolean) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    onResync: () => () => {},
    onEvent: () => () => {},
    call: vi.fn().mockImplementation(async (method: string) => {
      if (method === "daemon.shutdown") {
        client.connected = false;
        listeners.forEach((listener) => listener(false));
      }
      return {};
    }),
  };
  const refresh = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const hook = renderHook(() => {
    const updater = useAppUpdater(client as unknown as RpcClient, onError);
    const connection = useDaemonConnection({
      client: client as unknown as RpcClient, refreshWorkspaces: refresh,
      refreshSessions: refresh, onError, paused: updater.state.phase === "installing",
    });
    return { ...updater, connection };
  });
  return { ...hook, client, onError };
}

async function available(hook: ReturnType<typeof setup>) {
  await waitFor(() => expect(hook.result.current.connection.connectionEpoch).toBe(1));
  await act(async () => { await hook.result.current.checkNow(); });
  expect(hook.result.current.state.phase).toBe("available");
}

it("blocks restart before shutdown and waits for the captured process before installing", async () => {
  const hook = setup();
  await available(hook);
  let exited!: () => void;
  fake.invoke.mockImplementation(async (command: string) => {
    if (command === "wait_for_daemon_exit") await new Promise<void>((resolve) => { exited = resolve; });
  });
  let pending!: Promise<void>;
  await act(async () => { pending = hook.result.current.install(); });
  await waitFor(() => expect(fake.invoke).toHaveBeenCalledWith("wait_for_daemon_exit"));
  expect(fake.install).not.toHaveBeenCalled();
  expect(fake.resolveConnection).toHaveBeenCalledTimes(1);
  expect(fake.invoke.mock.invocationCallOrder[0]).toBeLessThan(
    hook.client.call.mock.invocationCallOrder[hook.client.call.mock.calls.findIndex(([method]) => method === "daemon.shutdown")],
  );
  await act(async () => { exited(); await pending; });
  expect(fake.install).toHaveBeenCalledOnce();
  expect(fake.relaunch).toHaveBeenCalledOnce();
  expect(fake.resolveConnection).toHaveBeenCalledTimes(1);
  expect(fake.invoke).not.toHaveBeenCalledWith("cancel_daemon_update");
});

it.each(["daemon.shutdown", "wait_for_daemon_exit", "install"])("restores normal reconnect after %s fails", async (stage) => {
  const hook = setup();
  await available(hook);
  if (stage === "daemon.shutdown") {
    hook.client.call.mockImplementation(async (method: string) => {
      if (method === stage) throw new Error("shutdown failed");
      return {};
    });
  } else if (stage === "install") {
    fake.install.mockRejectedValue(new Error("installer failed"));
  } else {
    fake.invoke.mockImplementation(async (command: string) => {
      if (command === stage) throw new Error("process still running");
    });
  }
  await act(async () => { await hook.result.current.install(); });
  await waitFor(() => expect(fake.resolveConnection).toHaveBeenCalledTimes(2));
  expect(fake.invoke).toHaveBeenCalledWith("cancel_daemon_update");
  expect(hook.result.current.state.phase).toBe("error");
  if (stage !== "install") expect(fake.install).not.toHaveBeenCalled();
  expect(fake.relaunch).not.toHaveBeenCalled();
});

it("does not stop the daemon when downloading or preparing fails", async () => {
  const hook = setup();
  await available(hook);
  fake.download.mockRejectedValueOnce(new Error("signature invalid"));
  await act(async () => { await hook.result.current.install(); });
  expect(fake.invoke).not.toHaveBeenCalled();
  expect(hook.client.call).not.toHaveBeenCalledWith("daemon.shutdown");
  await act(async () => { await hook.result.current.checkNow(); });
  fake.invoke.mockRejectedValueOnce(new Error("cannot observe process"));
  await act(async () => { await hook.result.current.install(); });
  expect(hook.client.call).not.toHaveBeenCalledWith("daemon.shutdown");
  expect(fake.install).not.toHaveBeenCalled();
});

it("prevents duplicate installs and keeps restart blocked after the installer starts", async () => {
  const hook = setup();
  await available(hook);
  let downloaded!: () => void;
  fake.download.mockImplementation(() => new Promise<void>((resolve) => { downloaded = resolve; }));
  fake.relaunch.mockRejectedValue(new Error("relaunch failed"));
  let pending!: Promise<void>;
  await act(async () => {
    pending = hook.result.current.install();
    await hook.result.current.install();
  });
  expect(fake.download).toHaveBeenCalledOnce();
  await act(async () => { downloaded(); await pending; });
  expect(hook.result.current.state.phase).toBe("installing");
  expect(fake.invoke).not.toHaveBeenCalledWith("cancel_daemon_update");
  expect(fake.resolveConnection).toHaveBeenCalledTimes(1);
  expect(hook.onError).toHaveBeenCalled();
});
