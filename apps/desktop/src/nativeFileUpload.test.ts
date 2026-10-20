import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ pickUpload: vi.fn(), upload: vi.fn(), releaseUpload: vi.fn(), cancel: vi.fn(), addListener: vi.fn(), remove: vi.fn() }));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));
import * as transfer from "./nativeFileTransfer";

const source = { id: "native-source-1", name: "原件.heic", size: 200 * 1024 * 1024, sha256: "a".repeat(64) };
beforeEach(() => {
  native.pickUpload.mockResolvedValue({ files: [source] });
  native.upload.mockResolvedValue({ status: "uploaded" });
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
