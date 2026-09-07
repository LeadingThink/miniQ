import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "./rpc";
import { decryptRemotePayload, deriveRemoteIdentity, encryptRemotePayload } from "./remoteCrypto";
import { RemotePayloadReader } from "./remotePayload";

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
    vi.restoreAllMocks();
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

  async function remoteClient() {
    const client = new RpcClient();
    const info = { kind: "remote" as const, apiKey: "test-only-key", relayUrl: "ws://relay.test/ws", deviceId: "mobile-test", deviceName: "test" };
    const connected = client.connect(info);
    const concurrent = client.connect(info);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "ready", desktopOnline: true });
    await connected;
    await concurrent;
    const { encryptionKey } = await deriveRemoteIdentity(info.apiKey);
    const receive = async (payload: unknown) => {
      const encrypted = await encryptRemotePayload(encryptionKey, payload);
      socket.receive({ type: "frame", ...encrypted });
    };
    return { client, socket, receive };
  }

  it("does not disconnect or stop other listeners when a UI event listener throws", async () => {
    const { client, receive } = await remoteClient();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const received = vi.fn();
    client.onEvent(() => { throw new Error("view failed"); });
    client.onEvent(received);
    await receive({ type: "remote_batch", items: [
      { type: "turn_failed", sessionId: "a", error: "A error" },
      { type: "turn_completed", sessionId: "b" },
    ] });
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    expect(client.connected).toBe(true);
  });

  it("extends only the matching RPC idle timeout while a large response arrives", async () => {
    const { client, receive } = await remoteClient();
    const response = client.call("session.open", { sessionId: "large" });
    const expected = { id: "req_1", result: { text: "a large response" } };
    const bytes = Buffer.from(JSON.stringify(expected));
    const reader = vi.spyOn(RemotePayloadReader.prototype, "read");
    await vi.advanceTimersByTimeAsync(40_000);
    await receive({ type: "remote_chunk", transferId: "large", index: 0, totalBytes: bytes.length,
      requestId: "req_1", data: bytes.subarray(0, 20).toString("base64url") });
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(40_000);
    await receive({ type: "remote_chunk", transferId: "large", index: 1, totalBytes: bytes.length,
      requestId: "req_1", data: bytes.subarray(20).toString("base64url") });
    await expect(response).resolves.toEqual(expected.result);
    expect(client.connected).toBe(true);
  });

  it("requests a snapshot resync without closing a healthy remote connection", async () => {
    const { client, receive } = await remoteClient();
    const resync = vi.fn();
    client.onResync(resync);
    await receive({ type: "remote_resync" });
    await vi.waitFor(() => expect(resync).toHaveBeenCalledOnce());
    expect(client.connected).toBe(true);
  });

  it("cancels old requests on the wire without cancelling a model task or closing the connection", async () => {
    const {client,socket}=await remoteClient();
    const controller=new AbortController();
    const response=client.call("session.open",{sessionId:"old"},{signal:controller.signal});
    const rejected=expect(response).rejects.toMatchObject({name:"AbortError"});
    await vi.waitFor(()=>expect(socket.sent).toHaveLength(2));
    controller.abort();
    await rejected;
    await vi.waitFor(()=>expect(socket.sent).toHaveLength(3));
    const envelope=JSON.parse(socket.sent[2]);
    const {encryptionKey}=await deriveRemoteIdentity("test-only-key");
    await expect(decryptRemotePayload(encryptionKey,envelope.nonce,envelope.ciphertext)).resolves.toEqual({type:"remote_cancel",requestId:"req_1"});
    expect(client.connected).toBe(true);
  });

  it("resyncs when the desktop reconnects while the mobile socket remains open", async () => {
    const {client,socket}=await remoteClient();
    const resync=vi.fn();client.onResync(resync);
    socket.receive({type:"presence",desktopOnline:true,desktopConnectionId:"new-desktop-process"});
    await vi.waitFor(()=>expect(resync).toHaveBeenCalledOnce());
    socket.receive({type:"presence",desktopOnline:true,desktopConnectionId:"new-desktop-process"});
    await vi.advanceTimersByTimeAsync(1);
    expect(resync).toHaveBeenCalledOnce();
    expect(client.connected).toBe(true);
  });
});
