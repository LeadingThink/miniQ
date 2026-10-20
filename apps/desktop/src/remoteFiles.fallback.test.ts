import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readRemoteFile } from "./remoteFiles";
import type { RpcClient } from "./rpc";
import { prepareRemoteFile } from "./remoteTransfer";
import { remoteFileErrorMessage } from "./remoteFileErrors";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const ticket = () => ({ transferId: "t", getUrl: "https://s3.qiniucs.com/bucket/remote-files/r/x", expiresAt: Date.now() + 60000, size: 3, sha256: createHash("sha256").update("abc").digest("hex"), revision: "v1" });
function fixture(failure: unknown = new Error("File storage unavailable"), size = 3, kind = "pdf") {
  const call = vi.fn(async (method: string, raw?: unknown): Promise<Record<string, unknown>> => {
    const params = raw as { offset: number };
    if (method === "file.describe") return { path: "/x", kind, mimeType: "application/pdf", size, revision: "v1", chunkBytes: 2 };
    if (method === "file.download.prepare") throw failure;
    if (method === "file.read") { const end = Math.min(params.offset + 2, size); return { offset: params.offset, nextOffset: end, totalBytes: size, revision: "v1", done: end === size, dataBase64: btoa("abc".slice(params.offset, end)) }; }
    throw new Error(method);
  });
  return { call: call as typeof call & RpcClient["call"], mode: "remote" as const };
}
it("falls back to bounded connection chunks for small text when storage is unavailable", async () => {
  const client = fixture(undefined, 3, "text"); const onTransport = vi.fn();
  const file = await readRemoteFile("x", { client, sessionId: "s", onTransport });
  expect(file.content).toBe("abc");
  expect(file.transport).toBe("connection");
  expect(onTransport).toHaveBeenLastCalledWith("connection");
});
it.each([new Error("Permission denied"), new Error("文件版本已变化"), new Error("文件完整性校验失败"), new DOMException("cancelled", "AbortError"), { code: -32602, message: "Invalid params" }])("does not fallback for unsafe failures %s", async failure => {
  const client = fixture(failure, 3, "text");
  await expect(readRemoteFile("x", { client, sessionId: "s" })).rejects.toEqual(failure);
  expect(client.call.mock.calls.some(([m]) => m === "file.read")).toBe(false);
});
it("prefers storage for small text and avoids connection chunks", async () => {
  const client = fixture(undefined, 3, "text");
  const original = client.call.getMockImplementation()!;
  client.call.mockImplementation(async (method, params) => method === "file.download.prepare" ? ticket() : original(method, params));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("abc")));
  const result = await readRemoteFile("x", { client, sessionId: "s" });
  expect(result.content).toBe("abc");
  expect(result.transport).toBe("storage");
  expect(client.call.mock.calls.some(([method]) => method === "file.read")).toBe(false);
});
it("falls back for a small text URL network failure", async () => {
  const client = fixture(undefined, 3, "text");
  const original = client.call.getMockImplementation()!;
  client.call.mockImplementation(async (method, params) => method === "file.download.prepare" ? ticket() : original(method, params));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  const result = await readRemoteFile("x", { client, sessionId: "s" });
  expect(result.content).toBe("abc");
  expect(result.transport).toBe("connection");
});
it("does not exceed the connection fallback ceiling", async () => {
  const client = fixture(undefined, 256 * 1024 + 1, "text");
  await expect(readRemoteFile("x", { client, sessionId: "s" })).rejects.toThrow("File storage unavailable");
  expect(client.call.mock.calls.some(([m]) => m === "file.read")).toBe(false);
});
it("deduplicates tickets, isolates authority and revision, and refreshes expiry", async () => {
  const call = vi.fn(async (_m: string, p: unknown) => ({ ...ticket(), revision: (p as { revision: string }).revision }));
  const client = { call: call as typeof call & RpcClient["call"] };
  const [a,b] = await Promise.all([prepareRemoteFile(client,"s","x","v1"), prepareRemoteFile(client,"s","x","v1")]);
  expect(a).toEqual(b); expect(call).toHaveBeenCalledTimes(1);
  await prepareRemoteFile(client,"s","x","v1"); expect(call).toHaveBeenCalledTimes(1);
  await prepareRemoteFile(client,"other","x","v1");
  await prepareRemoteFile(client,"s","other","v1");
  await prepareRemoteFile(client,"s","x","v2");
  await prepareRemoteFile({ call: client.call },"s","x","v1");
  expect(call).toHaveBeenCalledTimes(5);
  vi.spyOn(Date,"now").mockReturnValue(Date.now()+120000);
  await prepareRemoteFile(client,"s","x","v1"); expect(call).toHaveBeenCalledTimes(6);
  vi.restoreAllMocks();
});
it("does not share caller cancellation or cache failures", async () => {
  let resolve!: (value: ReturnType<typeof ticket>) => void;
  const call = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockRejectedValueOnce(new Error("File storage unavailable")).mockResolvedValue(ticket());
  const client = { call }; const controller = new AbortController();
  const first = prepareRemoteFile(client,"s","x","v1",controller.signal);
  const second = prepareRemoteFile(client,"s","x","v1");
  controller.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  resolve(ticket()); await expect(second).resolves.toMatchObject({ revision: "v1" });
  await expect(prepareRemoteFile(client,"s","y","v1")).rejects.toThrow("storage");
  await expect(prepareRemoteFile(client,"s","y","v1")).resolves.toBeDefined();
  expect(call).toHaveBeenCalledTimes(3);
});
it("does not reuse a signed URL after the same client switches computers", async () => {
  const call = vi.fn().mockResolvedValue(ticket());
  const client = { call, targetDeviceId: "computer-a" };
  await prepareRemoteFile(client, "s", "x", "v1");
  client.targetDeviceId = "computer-b";
  await prepareRemoteFile(client, "s", "x", "v1");
  expect(call).toHaveBeenCalledTimes(2);
});
it("rejects a ticket that finishes after the target computer changes", async () => {
  let resolve!: (value: ReturnType<typeof ticket>) => void;
  const call = vi.fn(() => new Promise<ReturnType<typeof ticket>>(done => { resolve = done; }));
  const client = { call: call as typeof call & RpcClient["call"], targetDeviceId: "a" };
  const pending = prepareRemoteFile(client, "s", "x", "v1");
  client.targetDeviceId = "b";
  resolve(ticket());
  await expect(pending).rejects.toThrow("目标电脑已变化");
});
it("never falls back for binary previews when storage is unavailable", async () => {
  const client = fixture();
  await expect(readRemoteFile("x", {client,sessionId:"s"})).rejects.toThrow("File storage unavailable");
  expect(client.call.mock.calls.some(([m]) => m === "file.read")).toBe(false);
});
it("rejects corrupted connection chunks without publishing a partial blob", async () => {
  const client = fixture(undefined, 3, "text"); const original = client.call.getMockImplementation()!;
  client.call.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    return method === "file.read" ? { ...result, nextOffset: 999 } : result;
  });
  await expect(readRemoteFile("x", {client,sessionId:"s"})).rejects.toThrow("不完整");
});
it("propagates real download fetch failure without unsupported file.read",  async () => {
  const client = fixture(); const original = client.call.getMockImplementation()!;
  client.call.mockImplementation(async (method, params) => method === "file.download.prepare" ? ticket() : original(method, params));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  await expect(readRemoteFile("x", {client,sessionId:"s",download:true})).rejects.toThrow("Failed to fetch");
  expect(client.call.mock.calls.some(([m]) => m === "file.read")).toBe(false);
  expect(client.call.mock.calls.some(([m]) => m === "file.transfer.cancel")).toBe(false);
});
it("translates known failures and preserves unknown details", () => {
  expect(remoteFileErrorMessage({code:-32602,message:"File storage unavailable"})).toContain("存储");
  expect(remoteFileErrorMessage({code:-32602,message:"Invalid params: offset"})).toBe("Invalid params: offset");
});
