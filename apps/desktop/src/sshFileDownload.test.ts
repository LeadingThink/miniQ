import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readRemoteFile } from "./remoteFiles";
import { HostRpcClient } from "./hostRpc";
import { RpcClient } from "./rpc";

afterEach(() => vi.restoreAllMocks());

function fixture(bytes: Uint8Array, kind = "text", chunkBytes = 262144) {
  const root = new RpcClient();
  const call = vi.spyOn(root, "call").mockImplementation(async (method, raw) => {
    expect(method).toBe("host.call");
    const wrapped = raw as { hostId: string; method: string; params: Record<string, unknown> };
    expect(wrapped.hostId).toBe("server");
    const p = wrapped.params;
    expect(p.sessionId).toBe("session");
    if (wrapped.method === "file.describe") return {
      path: "/work/report", kind, mimeType: kind === "image" ? "image/png" : "application/octet-stream",
      size: bytes.length, revision: "v1", chunkBytes: 3 * 1024 * 1024,
    };
    if (wrapped.method === "file.download.prepare") return {
      transport: "connection", transferId: "download", size: bytes.length, revision: "v1", chunkBytes,
      sha256: createHash("sha256").update(bytes).digest("hex"), expiresAt: Date.now() + 60000,
    };
    if (wrapped.method === "file.transfer.cancel") return { status: "cancelled" };
    if (wrapped.method === "file.download.read") {
      expect(p.transferId).toBe("download");
      const offset = p.offset as number;
      const end = Math.min(offset + (p.length as number), bytes.length);
      return { offset, nextOffset: end, totalBytes: bytes.length, revision: "v1",
        done: end === bytes.length, dataBase64: Buffer.from(bytes.subarray(offset, end)).toString("base64") };
    }
    throw new Error(`unexpected method ${wrapped.method}`);
  });
  const client = new HostRpcClient(root, "server");
  const methods = () => call.mock.calls.map(([, raw]) => (raw as { method: string }).method);
  return { client, call, methods };
}

it("prepares and reads SSH script bytes through the real host wrapper", async () => {
  const contents = "#!/bin/sh\n# 中文分块\necho ok\n";
  const { client, methods } = fixture(new TextEncoder().encode(contents), "text", 5);
  const progress = vi.fn();
  const file = await readRemoteFile("script.sh", { client, sessionId: "session", onProgress: progress });
  expect(file.content).toBe(contents);
  expect(file.transport).toBe("connection");
  expect(methods()).toContain("file.download.prepare");
  expect(methods()).toContain("file.download.read");
  expect(methods()).not.toContain("file.read");
  expect(methods().at(-1)).toBe("file.transfer.cancel");
  expect(progress).toHaveBeenLastCalledWith(file.size, file.size);
});

it.each(["pdf", "image", "audio", "video", "docx", "xlsx", "pptx"])("previews SSH %s bytes without storage URLs", async kind => {
  const bytes = Uint8Array.from({ length: 600001 }, (_, n) => n % 251);
  const { client, methods } = fixture(bytes, kind);
  const file = await readRemoteFile("file", { client, sessionId: "session" });
  expect(new Uint8Array(await file.blob!.arrayBuffer())).toEqual(bytes);
  expect(file.remoteSource).toBeUndefined();
  expect(methods().filter(method => method === "file.download.read")).toHaveLength(3);
});

it("pages large text without losing a UTF-8 character at the boundary", async () => {
  const contents = "a".repeat(262143) + "中文\n";
  const { client, methods } = fixture(new TextEncoder().encode(contents));
  const first = await readRemoteFile("large.txt", { client, sessionId: "session" });
  expect(methods().filter(method => method === "file.download.read")).toHaveLength(1);
  expect(methods()).not.toContain("file.transfer.cancel");
  const second = await first.textPage!.next!();
  expect(first.content! + second.content!).toBe(contents);
  expect(second.textPage!.next).toBeUndefined();
  expect(methods().at(-1)).toBe("file.transfer.cancel");
});

it.each(["text", "unsupported"])("downloads all SSH %s bytes including empty files", async kind => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("original\r\n")]) {
    const { client, methods } = fixture(bytes, kind, 2);
    const file = await readRemoteFile("file", { client, sessionId: "session", download: true });
    expect(new Uint8Array(await file.blob!.arrayBuffer())).toEqual(bytes);
    expect(methods().at(-1)).toBe("file.transfer.cancel");
  }
});

it("closes a paged download when navigation aborts it", async () => {
  const controller = new AbortController();
  const { client, methods } = fixture(new TextEncoder().encode("a".repeat(300000)));
  const first = await readRemoteFile("large.txt", { client, sessionId: "session", signal: controller.signal });
  controller.abort();
  expect(methods().at(-1)).toBe("file.transfer.cancel");
  await expect(first.textPage!.next!()).rejects.toMatchObject({ name: "AbortError" });
  expect(methods().filter(method => method === "file.download.read")).toHaveLength(1);
});

it("releases a prepare response that arrives after cancellation", async () => {
  const controller = new AbortController();
  const { client, call, methods } = fixture(new Uint8Array([1]));
  const original = call.getMockImplementation()!;
  call.mockImplementation(async (method, raw, options) => {
    const result = await original(method, raw, options);
    if ((raw as { method: string }).method === "file.download.prepare") controller.abort();
    return result;
  });
  await expect(readRemoteFile("file", { client, sessionId: "session", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(methods()).not.toContain("file.download.read");
  expect(methods().at(-1)).toBe("file.transfer.cancel");
});

it.each(["nextOffset", "revision", "sha256"])("rejects corrupted %s and releases the handle", async field => {
  const { client, call, methods } = fixture(new Uint8Array([1, 2, 3]), "pdf");
  const original = call.getMockImplementation()!;
  call.mockImplementation(async (method, raw, options) => {
    const value = await original(method, raw, options) as Record<string, unknown>;
    const operation = (raw as { method: string }).method;
    if (field === "sha256" && operation === "file.download.prepare") value.sha256 = "0".repeat(64);
    if (field !== "sha256" && operation === "file.download.read") value[field] = field === "revision" ? "v2" : 999;
    return value;
  });
  await expect(readRemoteFile("file", { client, sessionId: "session" })).rejects.toThrow(/完整/);
  expect(methods().at(-1)).toBe("file.transfer.cancel");
});

it("does not mask an unsupported server method with file.read", async () => {
  const { client, call, methods } = fixture(new Uint8Array([1]));
  const original = call.getMockImplementation()!;
  call.mockImplementation(async (method, raw, options) => {
    if ((raw as { method: string }).method === "file.download.prepare") throw new Error("unknown method: file.download.prepare");
    return original(method, raw, options);
  });
  await expect(readRemoteFile("file", { client, sessionId: "session" })).rejects.toThrow("unknown method");
  expect(methods()).not.toContain("file.read");
});
