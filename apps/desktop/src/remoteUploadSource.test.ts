import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseUploadSources, stageBrowserUploadSources, UPLOAD_CHUNK_BYTES } from "./remoteUploadSource";
import { installUploadFileSystem } from "./testHelpers/uploadFileSystem";

let disk: Awaited<ReturnType<typeof installUploadFileSystem>>;
beforeEach(async () => { disk = await installUploadFileSystem(); });
afterEach(async () => { await disk.cleanup(); vi.unstubAllGlobals(); });

it("snapshots every queued original once to disk and hashes the identical bounded chunks", async () => {
  const bytes = Uint8Array.from({ length: UPLOAD_CHUNK_BYTES * 2 + 17 }, (_, i) => i % 251);
  const original = new File([bytes], "原图.heic", { type: "image/heic" });
  const wholeRead = vi.spyOn(original, "arrayBuffer").mockRejectedValue(new Error("whole file forbidden"));
  const slice = vi.spyOn(original, "slice");
  const sources = await stageBrowserUploadSources([original, new File(["second"], "文档.pdf")]);
  expect(slice.mock.calls).toEqual([[0, UPLOAD_CHUNK_BYTES], [UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2], [UPLOAD_CHUNK_BYTES * 2, bytes.length]]);
  expect(wholeRead).not.toHaveBeenCalled();
  expect(Math.max(...disk.writes)).toBe(UPLOAD_CHUNK_BYTES);
  expect(sources[0]).toMatchObject({ name: "原图.heic", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  slice.mockImplementation(() => { throw new DOMException("Permission expired", "NotReadableError"); });
  expect(sources[0].kind).toBe("browser");
  if (sources[0].kind !== "browser") throw new Error("browser cache expected");
  expect(new Uint8Array(await sources[0].file.arrayBuffer())).toEqual(bytes);
  await releaseUploadSources(sources);
  await releaseUploadSources(sources);
  expect(disk.removed).toHaveLength(2);
  expect(await disk.entries()).toEqual(["miniq-upload-cache"]);
});

it("removes all cached originals and the partial file when a later provider is unreadable", async () => {
  const bad = new File(["bad"], "offline.pdf");
  vi.spyOn(bad, "slice").mockImplementation(() => { throw new DOMException("Provider expired", "NotReadableError"); });
  await expect(stageBrowserUploadSources([new File(["ok"], "ok.txt"), bad])).rejects.toThrow("重新选择");
  expect(disk.removed).toHaveLength(2);
  expect(await disk.entries()).toEqual(["miniq-upload-cache"]);
});

it("checks cancellation between disk chunks and deletes only its partial cache", async () => {
  const controller = new AbortController();
  disk.beforeWrite(() => controller.abort());
  await expect(stageBrowserUploadSources([new File([new Uint8Array(UPLOAD_CHUNK_BYTES + 10)], "x.bin")], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(disk.writes).toEqual([UPLOAD_CHUNK_BYTES]);
  expect(disk.removed).toHaveLength(1);
  expect(await disk.entries()).toEqual(["miniq-upload-cache"]);
});

it("rejects oversized files before touching provider data or creating a cache", async () => {
  const file = new File(["x"], "too-big.bin");
  Object.defineProperty(file, "size", { value: 200 * 1024 * 1024 + 1 });
  const read = vi.spyOn(file, "slice");
  await expect(stageBrowserUploadSources([file])).rejects.toThrow("200 MiB");
  expect(read).not.toHaveBeenCalled();
  expect(await disk.entries()).toEqual([]);
});

it("does not silently copy a large file into JS memory when disk storage is unavailable", async () => {
  vi.stubGlobal("navigator", {});
  const file = new File(["x"], "x.bin");
  const read = vi.spyOn(file, "arrayBuffer");
  await expect(stageBrowserUploadSources([file])).rejects.toThrow("安全暂存");
  expect(read).not.toHaveBeenCalled();
});
