import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "./rpc";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(payload: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket closed");
    this.sent.push(payload);
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("RpcClient timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects a connection that never finishes its handshake", async () => {
    const client = new RpcClient();
    const connected = client.connect({ kind: "local", port: 9000, token: "token" });
    const rejected = expect(connected).rejects.toThrow("连接 miniQ daemon 超时");

    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("rejects an RPC request when the daemon never responds", async () => {
    const client = new RpcClient();
    const connected = client.connect({ kind: "local", port: 9000, token: "token" });
    FakeWebSocket.instances[0].open();
    await connected;

    const response = client.call("settings.get");
    const rejected = expect(response).rejects.toThrow("请求 settings.get 超时");
    await vi.advanceTimersByTimeAsync(60_000);

    await rejected;
  });

  it("clears the request timeout after a normal response", async () => {
    const client = new RpcClient();
    const connected = client.connect({ kind: "local", port: 9000, token: "token" });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;

    const response = client.call<{ ok: boolean }>("daemon.health");
    const request = JSON.parse(socket.sent[0]) as { id: string };
    socket.receive({ jsonrpc: "2.0", id: request.id, result: { ok: true } });

    await expect(response).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.connected).toBe(true);
  });

  it("does not let a stale socket close reject requests on a newer connection", async () => {
    const client = new RpcClient();
    const firstConnection = client.connect({ kind: "local", port: 9000, token: "token" });
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    await firstConnection;

    firstSocket.readyState = FakeWebSocket.CLOSED;
    const secondConnection = client.connect({ kind: "local", port: 9001, token: "token" });
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.open();
    await secondConnection;

    const response = client.call<{ ok: boolean }>("daemon.health");
    const request = JSON.parse(secondSocket.sent[0]) as { id: string };
    firstSocket.onclose?.();
    secondSocket.receive({ jsonrpc: "2.0", id: request.id, result: { ok: true } });

    await expect(response).resolves.toEqual({ ok: true });
  });

  it("ignores events arriving from a stale local socket", async () => {
    const client = new RpcClient();
    const firstConnection = client.connect({ kind: "local", port: 9000, token: "token" });
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    await firstConnection;
    firstSocket.readyState = FakeWebSocket.CLOSED;

    const secondConnection = client.connect({ kind: "local", port: 9001, token: "token" });
    FakeWebSocket.instances[1].open();
    await secondConnection;
    const listener = vi.fn();
    client.onEvent(listener);

    firstSocket.receive({ type: "turn_completed", sessionId: "stale-session" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("cleans up a request immediately when local sending fails", async () => {
    const client = new RpcClient();
    const connected = client.connect({ kind: "local", port: 9000, token: "token" });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    socket.readyState = FakeWebSocket.CLOSED;

    await expect(client.call("daemon.health")).rejects.toThrow("daemon 连接已关闭");
    await vi.advanceTimersByTimeAsync(60_000);
  });
});
