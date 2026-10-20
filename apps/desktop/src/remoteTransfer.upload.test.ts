import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpc";
import { uploadRemoteFile } from "./remoteTransfer";
import { installUploadFileSystem } from "./testHelpers/uploadFileSystem";
import type { RemoteUploadSource } from "./remoteUploadSource";
const native = vi.hoisted(() => ({ putNativeUploadFile: vi.fn(), pickNativeUploadFiles: vi.fn(), releaseNativeUploadFiles: vi.fn() }));
vi.mock("./nativeFileTransfer", () => native);

const url = "https://bucket.s3.cn-south-1.qiniucs.com/remote-files/room/file?signature=fixture";
let disk: Awaited<ReturnType<typeof installUploadFileSystem>>;
beforeEach(async () => { disk = await installUploadFileSystem(); });
afterEach(async () => { await disk.cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("uploads the bytes already read even when the provider File expires while preparing the ticket", async () => {
  const bytes = Uint8Array.from([0, 255, 1, 128, 9]);
  const file = new File([bytes], "原件.heic", { type: "image/heic" });
  let readable = true;
  const originalRead = file.arrayBuffer.bind(file);
  vi.spyOn(file, "arrayBuffer").mockImplementation(() => readable
    ? originalRead()
    : Promise.reject(new DOMException("Provider permission expired", "NotReadableError")));
  const bodies: Uint8Array[] = [];
  class Request {
    status = 200;
    upload = {};
    onload?: () => void;
    onerror?: () => void;
    onloadend?: () => void;
    open() {}
    setRequestHeader() {}
    send(body: Blob) {
      void body.arrayBuffer().then((value) => { bodies.push(new Uint8Array(value)); this.onload?.(); }, () => this.onerror?.())
        .finally(() => this.onloadend?.());
    }
    abort() {}
  }
  vi.stubGlobal("XMLHttpRequest", Request);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const call = vi.fn(async (method: string) => {
    if (method === "file.upload.prepare") {
      readable = false;
      return { transferId: "t", putUrl: url, expiresAt: Date.now() + 60000 };
    }
    if (method === "file.upload.commit") return { status: "completed", path: "/project/inbox/原件.heic", size: bytes.length, sha256: hash };
    return { status: "cancelled" };
  });
  await expect(uploadRemoteFile({ call: call as RpcClient["call"] }, { sessionId: "original-session" }, file)).resolves.toMatchObject({ status: "completed", sha256: hash });
  expect(bodies).toEqual([bytes]);
  expect(file.arrayBuffer).not.toHaveBeenCalled();
});

it("uploads a 200 MiB native cache by id, renews a rejected ticket and keeps the captured workspace", async () => {
  const source: RemoteUploadSource = { kind: "native", id: "native-original", name: "原件.heic", size: 200 * 1024 * 1024, sha256: "a".repeat(64), release: vi.fn(async () => {}) };
  native.putNativeUploadFile.mockRejectedValueOnce(new Error("上传失败 (403)")).mockResolvedValueOnce(undefined);
  const xhr = vi.fn(() => { throw new Error("No native bytes may enter the WebView"); });
  vi.stubGlobal("XMLHttpRequest", xhr);
  const scope = { workspaceId: "original-workspace" };
  const call = vi.fn(async (method: string) => {
    scope.workspaceId = "another-workspace";
    if (method === "file.upload.prepare") return { transferId: "t", putUrl: url, expiresAt: Date.now() + 60000 };
    if (method === "file.upload.commit") return { status: "completed", path: "/project/inbox/original.heic", size: source.size, sha256: source.sha256 };
    return { status: "cancelled" };
  });
  await expect(uploadRemoteFile({ call: call as RpcClient["call"] }, scope, source)).resolves.toMatchObject({ status: "completed" });
  expect(native.putNativeUploadFile).toHaveBeenCalledTimes(2);
  expect(native.putNativeUploadFile).toHaveBeenCalledWith(source.id, url, undefined, undefined);
  expect(xhr).not.toHaveBeenCalled();
  for (const args of call.mock.calls as unknown as [string, Record<string, unknown>][]) expect(args[1].workspaceId).toBe("original-workspace");
  // The queue owns a pre-staged source and releases it after terminal handling.
  expect(source.release).not.toHaveBeenCalled();
});

it("cancels a native upload whose ticket arrives after abort without sending cached bytes", async () => {
  const controller = new AbortController();
  const source: RemoteUploadSource = { kind: "native", id: "native-original", name: "x.heic", size: 4, sha256: "a".repeat(64), release: vi.fn(async () => {}) };
  const call = vi.fn(async (method: string) => {
    if (method === "file.upload.prepare") {
      controller.abort();
      return { transferId: "late", putUrl: url, expiresAt: Date.now() + 60000 };
    }
    return { status: "cancelled" };
  });
  await expect(uploadRemoteFile({ call: call as RpcClient["call"] }, { sessionId: "original-session" }, source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(native.putNativeUploadFile).not.toHaveBeenCalled();
  expect(call).toHaveBeenLastCalledWith("file.transfer.cancel", { sessionId: "original-session", transferId: "late" });
});
