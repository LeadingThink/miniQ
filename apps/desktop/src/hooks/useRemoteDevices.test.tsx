// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteCredentials } from "../remoteAccess";
import { useRemoteDevices } from "./useRemoteDevices";

const deriveRemoteIdentity = vi.hoisted(() => vi.fn());
vi.mock("../remoteCrypto", () => ({ deriveRemoteIdentity }));

class DiscoverySocket {
  static instances: DiscoverySocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());

  constructor(readonly url: string) {
    DiscoverySocket.instances.push(this);
  }

  receive(value: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

const credentials: RemoteCredentials = {
  apiKey: "test-api-key", relayUrl: "wss://relay.example.test/ws",
  deviceId: "phone-1", deviceName: "手机",
};
const identity = { roomId: "room-1", authToken: "test-auth-token" };
const desktop = { deviceId: "desktop-1", deviceName: "办公室 Mac", online: true };

beforeEach(() => {
  vi.useFakeTimers();
  DiscoverySocket.instances = [];
  vi.stubGlobal("WebSocket", DiscoverySocket);
  deriveRemoteIdentity.mockResolvedValue(identity);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function mountDiscovery() {
  const hook = renderHook(() => useRemoteDevices(credentials));
  expect(hook.result.current).toMatchObject({ devices: [], loading: true, error: null });
  await act(async () => {});
  expect(DiscoverySocket.instances).toHaveLength(1);
  const socket = DiscoverySocket.instances[0];
  act(() => socket.onopen?.());
  return { ...hook, socket };
}

it("sends only a protocol 2 discovery hello without a target or business requests", async () => {
  const { socket, result } = await mountDiscovery();
  expect(deriveRemoteIdentity).toHaveBeenCalledWith(credentials.apiKey);
  expect(socket.url).toBe(credentials.relayUrl);
  expect(result.current.scope).toBe(identity.roomId);
  const hello = {
    type: "hello", protocol: 2, role: "mobile", ...identity,
    deviceId: credentials.deviceId, deviceName: credentials.deviceName,
  };
  expect(socket.send.mock.calls.map(([value]) => JSON.parse(value))).toEqual([hello]);
  act(() => {
    socket.receive({ type: "devices", devices: [desktop] });
    socket.receive({ type: "ready", peerOnline: true });
    socket.receive({ type: "peer", online: true });
    socket.receive({ type: "rpc", id: 1, method: "sessions.list", params: {} });
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(socket.send.mock.calls.map(([value]) => JSON.parse(value))).toEqual([hello]);
  expect(socket.close).not.toHaveBeenCalled();
});

it("replaces directory snapshots, retains offline devices and filters invalid records", async () => {
  const { socket, result } = await mountDiscovery();
  act(() => socket.receive({ type: "devices", devices: [desktop, null,
    { deviceId: 42, deviceName: "invalid", online: true },
    { deviceId: "bad-name", online: true },
    { deviceId: "bad-online", deviceName: "invalid", online: "true" },
  ] }));
  expect(result.current).toMatchObject({
    loading: false, error: null,
    devices: [{ id: "desktop-1", name: "办公室 Mac", online: true }],
  });
  act(() => socket.receive({ type: "devices", devices: [
    { ...desktop, deviceName: "办公室 Mac（离线）", online: false },
    { deviceId: "desktop-2", deviceName: "家中电脑", online: true },
  ] }));
  expect(result.current.devices).toEqual([
    { id: "desktop-1", name: "办公室 Mac（离线）", online: false },
    { id: "desktop-2", name: "家中电脑", online: true },
  ]);
  act(() => socket.receive({ type: "devices", devices: [] }));
  expect(result.current.devices).toEqual([]);
  expect(result.current.loading).toBe(false);
});

it("reports a disconnected directory and recovers on the retry connection", async () => {
  const { socket, result } = await mountDiscovery();
  act(() => {
    socket.receive({ type: "devices", devices: [desktop] });
    socket.onclose?.();
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBe("电脑列表连接已断开，正在重试…");
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(DiscoverySocket.instances).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(DiscoverySocket.instances).toHaveLength(2);
  expect(result.current.loading).toBe(true);
  const replacement = DiscoverySocket.instances[1];
  act(() => {
    replacement.onopen?.();
    replacement.receive({ type: "devices", devices: [{ ...desktop, online: false }] });
    socket.receive({ type: "devices", devices: [desktop] });
  });
  expect(result.current).toMatchObject({ loading: false, error: null,
    devices: [{ id: "desktop-1", name: "办公室 Mac", online: false }],
  });
});

it("closes on unmount and ignores late messages and lifecycle callbacks without retrying", async () => {
  const { socket, result, unmount } = await mountDiscovery();
  act(() => socket.receive({ type: "devices", devices: [desktop] }));
  const before = result.current;
  // Simulate events already queued when the socket is closed.
  const lateMessage = socket.onmessage!;
  const lateOpen = socket.onopen!;
  const lateClose = socket.onclose!;
  const lateError = socket.onerror!;
  unmount();
  expect(socket.close).toHaveBeenCalledTimes(1);
  const readData = vi.fn(() => JSON.stringify({ type: "devices", devices: [] }));
  const event = new MessageEvent("message");
  Object.defineProperty(event, "data", { get: readData });
  await act(async () => {
    lateMessage(event);
    lateOpen();
    lateClose();
    lateError();
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
  });
  // An unread event proves the guard works beyond React dropping unmounted updates.
  expect(readData).not.toHaveBeenCalled();
  expect(result.current).toBe(before);
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(socket.send).toHaveBeenCalledTimes(1);
  expect(deriveRemoteIdentity).toHaveBeenCalledTimes(1);
  expect(DiscoverySocket.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending retry when unmounted", async () => {
  const { socket, unmount } = await mountDiscovery();
  act(() => socket.onclose?.());
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(DiscoverySocket.instances).toHaveLength(1);
  expect(deriveRemoteIdentity).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not create a socket when identity derivation finishes after unmount", async () => {
  let finish!: (value: typeof identity) => void;
  deriveRemoteIdentity.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { unmount } = renderHook(() => useRemoteDevices(credentials));
  unmount();
  await act(async () => { finish(identity); });
  expect(DiscoverySocket.instances).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
