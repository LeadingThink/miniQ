import type { RpcClient } from "./rpc";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { downloadRemoteFile, sha256File, validateSignedStorageUrl } from "./remoteTransfer";
const url = "https://bucket.s3.cn-south-1.qiniucs.com/remote-files/room/file?signature=private";
afterEach(() => vi.unstubAllGlobals());
it.each([0, 1, 55, 64, 65, 1024 * 1024 + 17])("hashes %i original bytes incrementally", async (size) => {
    const bytes = new Uint8Array(size).map((_, i) => i % 251);
    const blob = new Blob([bytes]);
    const read = vi.spyOn(blob, "arrayBuffer").mockRejectedValue(new Error("whole file read forbidden"));
    expect(await sha256File(blob)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(read).not.toHaveBeenCalled();
});
it.each(["http://bucket.qiniucs.com/remote-files/r/x", "https://bucket.qiniucs.com.evil.test/remote-files/r/x", "https://u:p@bucket.qiniucs.com/remote-files/r/x", "https://bucket.qiniucs.com/provider-media/r/x"])("rejects unsafe storage URL %s", (value) => expect(() => validateSignedStorageUrl(value)).toThrow());
it("renews expired signed downloads and validates bytes", async () => {
    const bytes = new TextEncoder().encode("original中文");
    const ticket = { transferId: "t", getUrl: url, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), revision: "v1", expiresAt: Date.now() + 100000 };
    const call = vi.fn().mockResolvedValueOnce({ ...ticket, expiresAt: 1 }).mockResolvedValue(ticket);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));
    const result = await downloadRemoteFile({ call }, "s", "x", "v1");
    expect(await result.blob.text()).toBe("original中文");
    expect(call).toHaveBeenCalledTimes(2);
});
it("rejects a corrupt download", async () => {
    const call = vi.fn().mockResolvedValue({ transferId: "t", getUrl: url, size: 3, sha256: "0".repeat(64), revision: "v1", expiresAt: Date.now() + 100000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad")));
    await expect(downloadRemoteFile({ call }, "s", "x", "v1")).rejects.toThrow("完整性");
    expect(call).toHaveBeenLastCalledWith("file.transfer.cancel", { sessionId: "s", transferId: "t" });
});
import { uploadRemoteFile } from "./remoteTransfer";
import { Sha256 } from "./incrementalSha256";
it("hashes irregular stream chunks across SHA block boundaries", () => {
    const bytes = new Uint8Array(5000).map((_, i) => i % 251);
    const hash = new Sha256();
    for (let i = 0; i < bytes.length; i += 17)
        hash.update(bytes.subarray(i, i + 17));
    expect(hash.hex()).toBe(createHash("sha256").update(bytes).digest("hex"));
});
function uploadFixture(statuses = [200], abort?: AbortController) {
    const bodies: unknown[] = [];
    const headers: unknown[] = [];
    class Request {
        status = statuses.shift() ?? 200;
        upload = {};
        onload?: () => void;
        onabort?: () => void;
        onloadend?: () => void;
        open = vi.fn();
        setRequestHeader = (...args: unknown[]) => headers.push(args);
        send = (body: unknown) => { bodies.push(body); queueMicrotask(() => { if (abort)
            abort.abort();
        else
            this.onload?.(); this.onloadend?.(); }); };
        abort = () => { this.onabort?.(); this.onloadend?.(); };
    }
    vi.stubGlobal("XMLHttpRequest", Request);
    const file = new File([new Uint8Array([1, 2, 3, 255])], "照片.heic", { type: "image/heic" });
    const sha256 = createHash("sha256").update(new Uint8Array([1, 2, 3, 255])).digest("hex");
    const call = vi.fn(async (method: string) => method === "file.upload.prepare"
        ? { transferId: "t", putUrl: url, expiresAt: Date.now() + 60000 }
        : method === "file.upload.commit" ? { status: "completed", path: "/project/inbox/照片.heic", size: file.size, sha256 }
            : { status: "cancelled" });
    return { file, call, bodies, headers, sha256 };
}
it("uploads original HEIC bytes with octet-stream and waits for a validated receipt", async () => {
    const f = uploadFixture();
    const result = await uploadRemoteFile({ call: f.call as RpcClient["call"] }, { sessionId: "s" }, f.file);
    expect(result.status).toBe("completed");
    expect(f.bodies).toEqual([f.file]);
    expect(f.headers).toContainEqual(["Content-Type", "application/octet-stream"]);
    expect(f.call).toHaveBeenCalledWith("file.upload.prepare", { sessionId: "s", name: "照片.heic", size: 4, sha256: f.sha256 }, { timeoutMs: 600000 });
    expect(f.call).toHaveBeenLastCalledWith("file.upload.commit", { sessionId: "s", transferId: "t" }, { timeoutMs: 600000 });
});
it("renews a rejected PUT ticket once", async () => {
    const f = uploadFixture([403, 200]);
    await uploadRemoteFile({ call: f.call as RpcClient["call"] }, { sessionId: "s" }, f.file);
    expect(f.call.mock.calls.filter(([m]) => m === "file.upload.prepare")).toHaveLength(2);
    expect(f.bodies).toEqual([f.file, f.file]);
});
it("cancels upload and confirms daemon terminal status without commit", async () => {
    const controller = new AbortController();
    const f = uploadFixture([200], controller);
    await expect(uploadRemoteFile({ call: f.call as RpcClient["call"] }, { sessionId: "s" }, f.file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.call).toHaveBeenLastCalledWith("file.transfer.cancel", { sessionId: "s", transferId: "t" });
    expect(f.call.mock.calls.some(([m]) => m === "file.upload.commit")).toBe(false);
});
it("rejects files larger than 200 MiB before preparing any ticket", async () => {
    const f = uploadFixture();
    Object.defineProperty(f.file, "size", { value: 200 * 1024 * 1024 + 1 });
    await expect(uploadRemoteFile({ call: f.call as RpcClient["call"] }, { sessionId: "s" }, f.file)).rejects.toThrow("200");
    expect(f.call).not.toHaveBeenCalled();
});

it("cancels during desktop commit and preserves a completed race receipt", async () => {
  const f = uploadFixture(); const controller = new AbortController();
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method: string) => {
    if (method === "file.upload.commit") { queueMicrotask(() => controller.abort()); return await new Promise<never>(() => {}); }
    if (method === "file.transfer.cancel") return { status: "completed", path: "/project/inbox/照片.heic", size: f.file.size, sha256: f.sha256 };
    return original(method);
  });
  const result = await uploadRemoteFile({ call: f.call as RpcClient["call"] }, { sessionId: "s" }, f.file, controller.signal);
  expect(result.status).toBe("completed");
  expect(f.call.mock.calls.filter(([m]) => m === "file.transfer.cancel")).toHaveLength(1);
});

it("accepts forcePathStyle bucket URLs on HTTPS 443", () => {
  expect(validateSignedStorageUrl("https://s3.qiniucs.com:443/BUCKET/remote-files/room/object?signature=private")).toBe("https://s3.qiniucs.com/BUCKET/remote-files/room/object?signature=private");
});
it.each(["https://s3.qiniucs.com:8443/BUCKET/remote-files/room/object", "https://s3.qiniucs.com/BUCKET/remote-files/room/object#fragment"])("rejects unsafe port or fragment %s", value => {
  expect(() => validateSignedStorageUrl(value)).toThrow("地址无效");
});

import { prepareRemotePreview, readRemoteRange } from "./remoteTransfer";
it("refuses a renewed preview whose revision changed", async () => {
  const ticket = { transferId: "t", getUrl: url, size: 3, sha256: "0".repeat(64), revision: "v1", expiresAt: Date.now() + 60000 };
  const call = vi.fn().mockResolvedValueOnce(ticket).mockResolvedValue({ ...ticket, revision: "v2" });
  const source = await prepareRemotePreview({ call }, "s", "x", "v1", 3);
  await expect(source.refresh()).rejects.toThrow("版本已变化");
});
it("does not silently download a whole file when the storage ignores Range", async () => {
  const call = vi.fn().mockResolvedValue({ transferId: "t", getUrl: url, size: 1000000, sha256: "0".repeat(64), revision: "v1", expiresAt: Date.now() + 60000 });
  const source = await prepareRemotePreview({ call }, "s", "x", "v1", 1000000);
  const response = new Response("ignored"); const cancel = vi.spyOn(response.body!, "cancel");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(readRemoteRange(source, 0, 256 * 1024)).rejects.toThrow("有效分段");
  expect(cancel).toHaveBeenCalled();
});
it("renews a forbidden range once and returns only the requested bytes", async () => {
  const call = vi.fn().mockResolvedValue({ transferId: "t", getUrl: url, size: 10, sha256: "0".repeat(64), revision: "v1", expiresAt: Date.now() + 60000 });
  const source = await prepareRemotePreview({ call }, "s", "x", "v1", 10);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("expired", { status: 403 })).mockResolvedValueOnce(new Response("123", { status: 206, headers: { "Content-Range": "bytes 2-4/10" } })));
  const result = await readRemoteRange(source, 2, 3);
  expect(new TextDecoder().decode(result.bytes)).toBe("123");
  expect(call).toHaveBeenLastCalledWith("file.download.prepare", expect.objectContaining({ forceRefresh: true }), expect.anything());
  await expect(result.source.refresh()).rejects.toThrow("刷新失败");
});

it("scopes prepare, commit and cancel by workspace when no session exists", async () => {
  const f = uploadFixture();
  await uploadRemoteFile({ call: f.call as RpcClient["call"] }, { workspaceId: "w" }, f.file);
  expect(f.call).toHaveBeenCalledWith("file.upload.prepare", { workspaceId: "w", name: "照片.heic", size: 4, sha256: f.sha256 }, { timeoutMs: 600000 });
  expect(f.call).toHaveBeenLastCalledWith("file.upload.commit", { workspaceId: "w", transferId: "t" }, { timeoutMs: 600000 });
  const controller = new AbortController();
  const aborted = uploadFixture([200], controller);
  await expect(uploadRemoteFile({ call: aborted.call as RpcClient["call"] }, { workspaceId: "w" }, aborted.file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(aborted.call).toHaveBeenLastCalledWith("file.transfer.cancel", { workspaceId: "w", transferId: "t" });
  expect(JSON.stringify(aborted.call.mock.calls)).not.toContain("sessionId");
});
