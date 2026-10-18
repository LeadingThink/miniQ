import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ save: vi.fn(), cancel: vi.fn(), addListener: vi.fn(), remove: vi.fn() }));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));
import { saveRemoteFile } from "./nativeFileTransfer";
const file = { url: "https://s3.qiniucs.com/bucket/remote-files/test?signature=fixture", filename: "original.heic", mimeType: "image/heic", size: 12, sha256: "a".repeat(64) };
describe("native remote file save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.addListener.mockResolvedValue({ remove: native.remove });
    native.remove.mockResolvedValue(undefined);
    native.cancel.mockResolvedValue(undefined);
  });
  it("uses the native streaming contract and scopes progress to its own operation", async () => {
    native.save.mockImplementation(async (value) => {
      const listener = native.addListener.mock.calls[0][1];
      listener({ id: "different", received: 1, total: 12 });
      listener({ id: value.id, received: 12, total: 12 });
      return { status: "saved" };
    });
    const progress = vi.fn();
    expect(await saveRemoteFile(file, { onProgress: progress })).toEqual({ status: "saved" });
    expect(native.save).toHaveBeenCalledWith({ ...file, id: expect.any(String) });
    expect(progress).toHaveBeenCalledExactlyOnceWith(12, 12);
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("keeps native failures as failures and always removes listeners", async () => {
    native.save.mockRejectedValue(new Error("integrity failed"));
    await expect(saveRemoteFile(file)).rejects.toThrow("integrity failed");
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("does not start an already cancelled operation", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await saveRemoteFile(file, { signal: controller.signal })).toEqual({ status: "cancelled" });
    expect(native.save).not.toHaveBeenCalled();
    expect(native.addListener).not.toHaveBeenCalled();
  });
  it("cancels the exact native transfer and waits for its terminal receipt", async () => {
    const controller = new AbortController();
    native.save.mockImplementation(async () => {
      controller.abort();
      return { status: "cancelled" };
    });
    expect(await saveRemoteFile(file, { signal: controller.signal })).toEqual({ status: "cancelled" });
    expect(native.cancel).toHaveBeenCalledWith({ id: native.save.mock.calls[0][0].id });
    expect(native.remove).toHaveBeenCalledOnce();
  });
});
