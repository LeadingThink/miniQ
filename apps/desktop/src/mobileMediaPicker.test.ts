// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_MOBILE_VIDEO_BYTES, readMobileMedia } from "./mobileChatMedia";

const bridge = vi.hoisted(() => ({ pick: vi.fn(), read: vi.fn() }));
vi.mock("./remoteUploadSource", async (original) => ({
  ...await original<typeof import("./remoteUploadSource")>(), pickUploadSources: bridge.pick,
}));
vi.mock("./nativeFileTransfer", () => ({ readNativeUploadChunk: bridge.read }));
import { pickMobileMediaFile } from "./mobileMediaPicker";

function source(bytes = new Uint8Array([0, 1, 255])) {
  return { kind: "native" as const, id: "cached-video", name: "phone.MOV", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), release: vi.fn().mockResolvedValue(undefined) };
}
afterEach(() => { bridge.pick.mockReset(); bridge.read.mockReset(); });

it("reads and verifies every bounded chunk of the native original and releases the cache", async () => {
  const bytes = new Uint8Array(Array.from({ length: 300_001 }, (_, index) => index % 256));
  const selected = source(bytes);
  bridge.pick.mockResolvedValue([selected]);
  bridge.read.mockImplementation((_id, start, length) => Promise.resolve(Buffer.from(bytes.slice(start, start + length)).toString("base64")));
  const file = await pickMobileMediaFile();
  expect(bridge.pick).toHaveBeenCalledWith("photos");
  expect(bridge.read.mock.calls).toEqual([[selected.id, 0, 262144], [selected.id, 262144, 37857]]);
  expect(file).toMatchObject({ name: "phone.MOV", size: bytes.length, type: "video/quicktime" });
  const media = await readMobileMedia(file!);
  expect(Buffer.from(media.dataUrl.split(",")[1], "base64")).toEqual(Buffer.from(bytes));
  expect(selected.release).toHaveBeenCalledOnce();
});

it("treats native cancellation as a no-op", async () => {
  bridge.pick.mockResolvedValue([]);
  await expect(pickMobileMediaFile()).resolves.toBeNull();
  expect(bridge.read).not.toHaveBeenCalled();
});

it("rejects a multiple selection explicitly and releases every original instead of taking only the first", async () => {
  const first = source(), second = { ...source(), id: "second" };
  bridge.pick.mockResolvedValue([first, second]);
  await expect(pickMobileMediaFile()).rejects.toThrow("每次只能附加");
  expect(bridge.read).not.toHaveBeenCalled();
  expect(first.release).toHaveBeenCalledOnce();
  expect(second.release).toHaveBeenCalledOnce();
});

it("rejects oversized media before reading and releases its private cache", async () => {
  const selected = { ...source(), size: MAX_MOBILE_VIDEO_BYTES + 1 };
  bridge.pick.mockResolvedValue([selected]);
  await expect(pickMobileMediaFile()).rejects.toThrow("视频不能超过 64 MiB");
  expect(bridge.read).not.toHaveBeenCalled();
  expect(selected.release).toHaveBeenCalledOnce();
});

it.each([
  ["AAE=", "读取不完整"], ["AAAA", "完整性验证失败"], [new Error("缓存读取失败"), "缓存读取失败"],
])("rejects damaged or unreadable media and releases it: %s", async (result, message) => {
  const selected = source();
  bridge.pick.mockResolvedValue([selected]);
  if (result instanceof Error) bridge.read.mockRejectedValue(result);
  else bridge.read.mockResolvedValue(result);
  await expect(pickMobileMediaFile()).rejects.toThrow(message);
  expect(selected.release).toHaveBeenCalledOnce();
});
