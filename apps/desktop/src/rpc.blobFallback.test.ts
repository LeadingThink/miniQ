import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, remoteClient } from "./testSupport/rpcSocket";
import { HostRpcClient } from "./hostRpc";

function blobReference() {
  return { type: "remote_blob", requestId: "req_1", url: "https://s3.cn-south-1.qiniucs.com/object",
    expiresAt: Date.now() + 60_000, bytes: 32, sha256: "0".repeat(64), nonce: "AAAAAAAAAAAAAAAA" };
}

describe("remote object transfer replay safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("recovers the complete image via encrypted chunks (SSH: %s)", async (ssh) => {
    const { client, socket, receive, sent } = await remoteClient();
    const reader = ssh ? new HostRpcClient(client, "server") : client;
    const params = { sessionId: "s", path: "/work/image.png", revision: "original", offset: 0 };
    const response = reader.call("file.read", params);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const original = await sent(1);
    expect(original.acceptBlob).toBe(true);
    expect(original.method).toBe(ssh ? "host.call" : "file.read");
    await receive(blobReference());
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(await sent(2)).toEqual({ ...original, acceptBlob: false });

    const result = { offset: 0, done: true, dataBase64: Buffer.from("完整图片".repeat(40_000)).toString("base64") };
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "req_1", result }));
    expect(bytes.length).toBeGreaterThan(128 * 1024);
    for (let offset = 0, index = 0; offset < bytes.length; offset += 64 * 1024, index++) {
      await receive({ type: "remote_chunk", transferId: "image", requestId: "req_1", index,
        totalBytes: bytes.length, data: bytes.subarray(offset, offset + 64 * 1024).toString("base64url") });
    }
    await expect(response).resolves.toEqual(result);
    expect(socket.sent).toHaveLength(3);
    expect(client.connected).toBe(true);
    client.disconnect();
  });

  it.each([
    ["file.describe", { sessionId: "s", path: "/work/image.png" }],
    ["file.list", { sessionId: "s", path: "/work" }],
    ["observation.read", { sessionId: "s", toolCallId: "image", offset: 0 }],
    ["session.open", { sessionId: "s" }],
    ["session.history", { sessionId: "s" }],
    ["session.sync", { sessionId: "s", cursor: "last" }],
    ["tool.detail", { sessionId: "s", toolCallId: "image" }],
    ["agent.history", { sessionId: "s", agentId: "child" }],
  ])("allows object transport for the audited read %s", async (method, params) => {
    const { client, socket, receive, sent } = await remoteClient();
    const response = client.call(method as string, params);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await sent(1)).acceptBlob).toBe(true);
    await receive({ jsonrpc: "2.0", id: "req_1", result: "read" });
    await expect(response).resolves.toBe("read");
    client.disconnect();
  });

  it.each([
    ["session.sendMessage", { sessionId: "s", message: { content: "run once" } }],
    ["session.rewriteMessage", { sessionId: "s" }],
    ["session.create", { workspaceId: "w" }],
    ["approval.resolve", { id: "approval", decision: "approve" }],
    ["question.resolve", { id: "question", answer: "yes" }],
    ["checkpoint.rollback", { checkpointId: "c" }],
    ["session.shareCreate", { sessionId: "s" }],
    ["voice.transcribe", { audio: "audio" }],
    ["host.connect", { hostId: "server" }],
    ["host.call", { hostId: "server", method: "session.sendMessage", params: {} }],
    ["host.call", { hostId: "a", method: "host.call", params: { hostId: "b", method: "file.read", params: {} } }],
    ["host.call", { hostId: "a", method: "host.call", params: { hostId: "b", method: "approval.resolve", params: {} } }],
    ["host.call", { hostId: "server" }],
    ["host.call", null],
    ["file.futureMutation", {}],
  ])("never retries commands or unaudited operations: %s", async (method, params) => {
    const { client, socket, receive, sent } = await remoteClient();
    const response = client.call(method as string, params);
    const rejected = expect(response).rejects.toThrow("Failed to fetch");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await sent(1)).acceptBlob).toBe(false);
    // Even a peer that ignores acceptBlob must not trigger command replay.
    await receive(blobReference());
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sent).toHaveLength(2);
    expect(client.connected).toBe(true);
    client.disconnect();
  });

  it("accepts a large command result through chunks without replaying the command", async () => {
    const { client, socket, receive, sent } = await remoteClient();
    const response = client.call("session.sendMessage", { sessionId: "s", message: { content: "run once" } });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await sent(1)).acceptBlob).toBe(false);
    const result = { queued: { content: "a".repeat(200_000) } };
    const bytes = Buffer.from(JSON.stringify({ id: "req_1", result }));
    for (let offset = 0, index = 0; offset < bytes.length; offset += 64 * 1024, index++) {
      await receive({ type: "remote_chunk", transferId: "command", requestId: "req_1", index,
        totalBytes: bytes.length, data: bytes.subarray(offset, offset + 64 * 1024).toString("base64url") });
    }
    await expect(response).resolves.toEqual(result);
    expect(socket.sent).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
    client.disconnect();
  });

  it("bounds read fallback to one retry and keeps the connection usable", async () => {
    const { client, socket, receive } = await remoteClient();
    const response = client.call("file.read", { sessionId: "s", path: "/work/image.png" });
    const rejected = expect(response).rejects.toThrow("Failed to fetch");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    await receive(blobReference());
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    await receive(blobReference());
    await rejected;
    expect(socket.sent).toHaveLength(3);
    const next = client.call("daemon.health");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(4));
    await receive({ id: "req_2", result: { ok: true } });
    await expect(next).resolves.toEqual({ ok: true });
    expect(client.connected).toBe(true);
    client.disconnect();
  });

  it("does not retry a download rejected after the user cancels the read", async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const { client, socket, receive, sent } = await remoteClient();
    const controller = new AbortController();
    const response = client.call("file.read", { sessionId: "s", path: "/work/image.png" }, { signal: controller.signal });
    const rejected = expect(response).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    await receive(blobReference());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    fail(new TypeError("Failed to fetch"));
    await rejected;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(await sent(2)).toEqual({ type: "remote_cancel", requestId: "req_1" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sent).toHaveLength(3);
    client.disconnect();
  });
});
