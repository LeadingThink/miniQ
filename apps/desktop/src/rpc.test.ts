import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "./rpc";
import { decryptRemotePayload, deriveRemoteIdentity } from "./remoteCrypto";
import { RemotePayloadReader } from "./remotePayload";
import * as remoteCrypto from "./remoteCrypto";
import { FakeWebSocket, remoteClient } from "./testSupport/rpcSocket";

function useLegacyAbortController() {
  class LegacyAbortController extends AbortController {
    constructor() {
      super();
      Object.defineProperties(this.signal, {
        throwIfAborted: { value: undefined },
        reason: { value: undefined },
      });
    }
  }
  vi.stubGlobal("AbortController", LegacyAbortController);
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

  it("keeps SSH events separate from root events", async () => {
    const client = new RpcClient();
    const connected = client.connect({ kind: "local", port: 9000, token: "fixture" });
    const socket = FakeWebSocket.instances[0];
    socket.open(); await connected;
    const local = vi.fn(), host = vi.fn();
    client.onEvent(local); client.onHostEvent(host);
    socket.receive({ type: "host_event", hostId: "dev", event: { type: "session_updated", sessionId: "same" } });
    expect(local).not.toHaveBeenCalled();
    expect(host).toHaveBeenCalledWith({ type: "host_event", hostId: "dev", event: { type: "session_updated", sessionId: "same" } });
  });

  it("rejects a connection that never finishes its handshake", async () => {
    const client = new RpcClient();
    const connected = client.connect({ kind: "local", port: 9000, token: "token" });
    const rejected = expect(connected).rejects.toThrow("连接 miniQ daemon 超时");

    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("keeps the root transport healthy after an SSH request times out", async () => {
    const client = new RpcClient();
    const connected = client.connect({ kind: "local", port: 9000, token: "fixture" });
    const socket = FakeWebSocket.instances[0]; socket.open(); await connected;
    const pending = client.call("host.call", { hostId: "slow", method: "session.open", params: { sessionId: "s" } }, { timeoutMs: 100 });
    const rejection = expect(pending).rejects.toThrow("请求 host.call 超时");
    await vi.advanceTimersByTimeAsync(100); await rejection;
    expect(client.connected).toBe(true);
    const health = client.call("daemon.health");
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.receive({ jsonrpc: "2.0", id: request.id, result: { status: "ok" } });
    await expect(health).resolves.toEqual({ status: "ok" });
    expect(FakeWebSocket.instances).toHaveLength(1);
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

  it("settles detached requests immediately without letting old timers close the new connection", async () => {
    const client = new RpcClient();
    const first = client.connect({ kind: "local", port: 9000, token: "token" });
    FakeWebSocket.instances[0].open();
    await first;
    const oldRequest = client.call("session.open", { sessionId: "old" });
    const rejected = expect(oldRequest).rejects.toThrow("connection closed");
    client.disconnect("foreground recovery");
    await rejected;
    const next = client.connect({ kind: "local", port: 9001, token: "token" });
    FakeWebSocket.instances[1].open();
    await next;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(client.connected).toBe(true);
  });

  it("cancels a pending local handshake and keeps replacement callers in one connection attempt", async () => {
    const client = new RpcClient();
    const first = client.connect({ kind: "local", port: 9000, token: "old" });
    const rejected = expect(first).rejects.toThrow("connection closed");
    const oldSocket = FakeWebSocket.instances[0];
    client.disconnect("switch daemon");
    expect(oldSocket.readyState).toBe(FakeWebSocket.CLOSED);
    const info = { kind: "local" as const, port: 9001, token: "new" };
    const next = client.connect(info);
    const concurrent = client.connect(info);
    await rejected;
    // The old connect() finally must not clear the newer single-flight state.
    const afterCancellation = client.connect(info);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const socket = FakeWebSocket.instances[1];
    oldSocket.open();
    expect(client.connected).toBe(false);
    socket.open();
    await Promise.all([next, concurrent, afterCancellation]);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(client.connected).toBe(true);
  });

  it("invalidates key derivation immediately so a cancelled identity cannot open an old-key socket", async () => {
    const identity = await deriveRemoteIdentity("old-test-key");
    let finishIdentity!: (value: typeof identity) => void;
    vi.spyOn(remoteCrypto, "deriveRemoteIdentity").mockImplementationOnce(
      () => new Promise((resolve) => { finishIdentity = resolve; }),
    );
    const client = new RpcClient();
    const old = client.connect({ kind: "remote", apiKey: "old-test-key", relayUrl: "ws://relay.test", deviceId: "test", deviceName: "test" });
    const rejected = expect(old).rejects.toThrow("connection closed");
    client.disconnect("key changed during derivation");
    await rejected;
    expect(FakeWebSocket.instances).toHaveLength(0);
    const next = client.connect({ kind: "local", port: 9001, token: "new" });
    FakeWebSocket.instances[0].open();
    await next;
    finishIdentity(identity);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.mode).toBe("local");
    expect(client.connected).toBe(true);
  });

  it("closes a relay awaiting ready and ignores its acknowledgement after switching keys", async () => {
    const client = new RpcClient();
    const info = { kind: "remote" as const, apiKey: "old-test-key", relayUrl: "ws://relay.test", deviceId: "test", deviceName: "test" };
    const first = client.connect(info);
    const rejected = expect(first).rejects.toThrow("connection closed");
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const oldSocket = FakeWebSocket.instances[0];
    oldSocket.open();
    expect(client.connected).toBe(false);
    client.disconnect("switch remote key");
    expect(oldSocket.readyState).toBe(FakeWebSocket.CLOSED);
    const nextInfo = { ...info, apiKey: "new-test-key" };
    const next = client.connect(nextInfo);
    await rejected;
    const concurrent = client.connect(nextInfo);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const socket = FakeWebSocket.instances[1];
    oldSocket.receive({ type: "ready", desktopOnline: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(client.connected).toBe(false);
    socket.open();
    expect(JSON.parse(socket.sent[0]).roomId).not.toBe(JSON.parse(oldSocket.sent[0]).roomId);
    socket.receive({ type: "ready", desktopOnline: true });
    await Promise.all([next, concurrent]);
    oldSocket.onclose?.();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(client.connected).toBe(true);
  });

  it("can retry a failed relay handshake without retaining its socket or single-flight promise", async () => {
    const client = new RpcClient();
    const info = { kind: "remote" as const, apiKey: "test-key", relayUrl: "ws://relay.test", deviceId: "test", deviceName: "test" };
    const first = client.connect(info);
    const rejected = expect(first).rejects.toThrow("桌面端尚未在线");
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].receive({ type: "ready", desktopOnline: false });
    await rejected;
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);
    const next = client.connect(info);
    const concurrent = client.connect(info);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].receive({ type: "ready", desktopOnline: true });
    await Promise.all([next, concurrent]);
    expect(client.connected).toBe(true);
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

  it("connects and cancels requests on iOS signals without modern abort methods", async () => {
    useLegacyAbortController();
    const { client, socket } = await remoteClient();
    const controller = new AbortController();
    const pending = client.call("session.open", { sessionId: "old" }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(client.connected).toBe(true);
    client.disconnect();
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("rejects cancelled handshakes with an error when signals have no reason", async () => {
    useLegacyAbortController();
    const client = new RpcClient();
    const pending = client.connect({ kind: "local", port: 9000, token: "token" });
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    client.disconnect();
    await rejected;
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);
  });

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

  it("ignores an old remote event that finishes decompression after reconnecting", async () => {
    const { client, receive } = await remoteClient();
    let finish!: (items: Awaited<ReturnType<RemotePayloadReader["readAsync"]>>) => void;
    const reading = vi.spyOn(RemotePayloadReader.prototype, "readAsync").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const received = vi.fn();
    client.onEvent(received);
    await receive({ type: "remote_batch", items: [] });
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1));
    client.disconnect("switch desktop");
    const connecting = client.connect({ kind: "local", port: 9010, token: "test" });
    FakeWebSocket.instances[1].open();
    await connecting;
    finish([{ type: "turn_failed", sessionId: "other-computer", error: "stale" }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).not.toHaveBeenCalled();
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

  it("keeps a remote socket alive when one request times out", async () => {
    const { client } = await remoteClient();
    const response = client.call("session.open", { sessionId: "slow" });
    const rejected = expect(response).rejects.toThrow("请求 session.open 超时");

    await vi.advanceTimersByTimeAsync(60_000);

    await rejected;
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
