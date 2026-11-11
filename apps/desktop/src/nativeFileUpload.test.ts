import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ pickUpload: vi.fn(), upload: vi.fn(), readUploadChunk: vi.fn(), releaseUpload: vi.fn(), cancel: vi.fn(), addListener: vi.fn(), remove: vi.fn() }));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));
import * as transfer from "./nativeFileTransfer";

const source = { id: "native-source-1", name: "原件.heic", size: 200 * 1024 * 1024, sha256: "a".repeat(64) };
beforeEach(() => {
  native.pickUpload.mockResolvedValue({ files: [source] });
  native.upload.mockResolvedValue({ status: "uploaded" });
  native.readUploadChunk.mockResolvedValue({ dataBase64: "AAH/" });
  native.addListener.mockResolvedValue({ remove: native.remove });
  native.remove.mockResolvedValue(undefined);
  native.cancel.mockResolvedValue(undefined);
  native.releaseUpload.mockResolvedValue(undefined);
});
afterEach(() => { vi.clearAllMocks(); });

it("returns only native cache metadata and uploads the opaque id without a File or base64", async () => {
  const files = await transfer.pickNativeUploadFiles("photos", 3);
  expect(files).toEqual([source]);
  expect(native.pickUpload).toHaveBeenCalledWith({ id: expect.any(String), kind: "photos", limit: 3 });
  const onProgress = vi.fn();
  native.upload.mockImplementation(async ({ id }) => {
    const listener = native.addListener.mock.calls[0][1];
    listener({ id: "other-operation", received: 2, total: source.size });
    listener({ id, received: source.size, total: source.size });
    return { status: "uploaded" };
  });
  await transfer.putNativeUploadFile(source.id, "https://signed.test", undefined, onProgress);
  expect(native.upload).toHaveBeenCalledWith({ id: expect.any(String), fileId: source.id, url: "https://signed.test" });
  expect(onProgress).toHaveBeenCalledExactlyOnceWith(source.size, source.size);
  expect(native.remove).toHaveBeenCalledOnce();
});

it("releases a late picker result when the initiating draft was cancelled", async () => {
  const controller = new AbortController();
  native.pickUpload.mockImplementation(async () => { controller.abort(); return { files: [source] }; });
  await expect(transfer.pickNativeUploadFiles("files", 10, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(native.cancel).toHaveBeenCalledWith({ id: native.pickUpload.mock.calls[0][0].id });
  expect(native.releaseUpload).toHaveBeenCalledExactlyOnceWith({ ids: [source.id] });
});

it("cancels the matching PUT and removes its progress listener", async () => {
  const controller = new AbortController();
  native.upload.mockImplementation(async () => { controller.abort(); return { status: "cancelled" }; });
  await expect(transfer.putNativeUploadFile(source.id, "https://signed.test", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(native.cancel).toHaveBeenCalledWith({ id: native.upload.mock.calls[0][0].id });
  expect(native.remove).toHaveBeenCalledOnce();
});

it("preserves storage status errors for the signed-ticket retry policy", async () => {
  native.upload.mockRejectedValue(new Error("上传失败 (403)"));
  await expect(transfer.putNativeUploadFile(source.id, "https://signed.test")).rejects.toThrow("(403)");
  expect(native.remove).toHaveBeenCalledOnce();
});

it("preserves a successful upload when bridge listener cleanup fails", async () => {
  native.remove.mockRejectedValueOnce(new Error("Bridge already released"));
  await expect(transfer.putNativeUploadFile(source.id, "https://signed.test")).resolves.toBeUndefined();
  expect(native.remove).toHaveBeenCalledOnce();
});

it("preserves the storage error when bridge listener cleanup also fails", async () => {
  native.upload.mockRejectedValueOnce(new Error("上传失败 (403)"));
  native.remove.mockRejectedValueOnce(new Error("Bridge already released"));
  await expect(transfer.putNativeUploadFile(source.id, "https://signed.test")).rejects.toThrow("(403)");
  expect(native.remove).toHaveBeenCalledOnce();
});

it.each([[0, 1], [65535, 262144], [Number.MAX_SAFE_INTEGER, 1]])("reads an exact native chunk at %i with length %i", async (offset, length) => {
  await expect(transfer.readNativeUploadChunk(source.id, offset, length)).resolves.toBe("AAH/");
  expect(native.readUploadChunk).toHaveBeenCalledExactlyOnceWith({ fileId: source.id, offset, length });
  expect(native.pickUpload).not.toHaveBeenCalled();
  expect(native.upload).not.toHaveBeenCalled();
  expect(native.releaseUpload).not.toHaveBeenCalled();
});

it.each([
  [-1, 1], [0.5, 1], [NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER + 1, 1],
  [0, 0], [0, -1], [0, 1.5], [0, 262145], [0, NaN], [0, Infinity],
  ["0", 1], [0, "1"], [true, 1], [0, false],
])("rejects invalid native chunk range %s/%s before crossing the bridge", async (offset, length) => {
  await expect(transfer.readNativeUploadChunk(source.id, offset as number, length as number)).rejects.toThrow("分块参数无效");
  expect(native.readUploadChunk).not.toHaveBeenCalled();
});

it("rejects an empty cache identity before crossing the bridge", async () => {
  await expect(transfer.readNativeUploadChunk("", 0, 1)).rejects.toThrow("分块参数无效");
  expect(native.readUploadChunk).not.toHaveBeenCalled();
});

it("does not read a chunk when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(transfer.readNativeUploadChunk(source.id, 0, 1, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(native.readUploadChunk).not.toHaveBeenCalled();
});

it.each([false, true])("discards a late native chunk result after abort (bridge rejects: %s)", async (reject) => {
  const controller = new AbortController();
  native.readUploadChunk.mockImplementationOnce(async () => {
    controller.abort();
    if (reject) throw new Error("cache released");
    return { dataBase64: "AAH/" };
  });
  await expect(transfer.readNativeUploadChunk(source.id, 0, 3, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(native.cancel).not.toHaveBeenCalled();
  expect(native.releaseUpload).not.toHaveBeenCalled();
});

it.each(["EOF", "out of range", "cache released", "unknown fileId"])("preserves native chunk rejection: %s", async (message) => {
  const error = new Error(message);
  native.readUploadChunk.mockRejectedValueOnce(error);
  await expect(transfer.readNativeUploadChunk(source.id, 0, 3)).rejects.toBe(error);
});
