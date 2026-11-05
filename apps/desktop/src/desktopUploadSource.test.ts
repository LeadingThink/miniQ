import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stageDesktopUploadSources } from "./desktopUploadSource";
import { releaseUploadSources, UPLOAD_CHUNK_BYTES } from "./remoteUploadSource";
import { installUploadFileSystem } from "./testHelpers/uploadFileSystem";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let disk: Awaited<ReturnType<typeof installUploadFileSystem>>;
beforeEach(async () => { disk = await installUploadFileSystem(); });
afterEach(async () => { await disk.cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

function nativeFile(bytes: Uint8Array, name = "完整原件.bin") {
  invoke.mockImplementation(async (command, args) => {
    if (command === "local_upload_file_info") return { name, size: bytes.length, modified: "1234" };
    if (command === "read_local_upload_chunk") return bytes.slice(args.offset, args.offset + args.length).buffer;
    throw new Error(`Unexpected command ${command}`);
  });
}

it("snapshots full desktop originals through bounded IPC without sending a local path to the remote host", async () => {
  const bytes = Uint8Array.from({ length: UPLOAD_CHUNK_BYTES * 2 + 17 }, (_, index) => index % 251);
  nativeFile(bytes);
  const path = "C:\\Users\\me\\完整原件.bin";
  const sources = await stageDesktopUploadSources([path]);
  expect(invoke.mock.calls).toEqual([
    ["local_upload_file_info", { path }],
    ...[0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2].map(offset => ["read_local_upload_chunk", {
      path, offset, length: Math.min(UPLOAD_CHUNK_BYTES, bytes.length - offset), expectedSize: bytes.length, expectedModified: "1234",
    }]),
  ]);
  expect(sources[0]).toMatchObject({ name: "完整原件.bin", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  if (sources[0].kind !== "browser") throw new Error("expected disk snapshot");
  expect(new Uint8Array(await sources[0].file.arrayBuffer())).toEqual(bytes);
  expect(sources[0]).not.toHaveProperty("path");
  await releaseUploadSources(sources);
  expect(await disk.entries()).toEqual(["miniq-upload-cache"]);
});

it("validates every selected file before reading bytes and never uploads a subset of an oversized selection", async () => {
  invoke.mockResolvedValueOnce({ name: "ok.txt", size: 1, modified: "1234" })
    .mockResolvedValueOnce({ name: "large.bin", size: 200 * 1024 * 1024 + 1, modified: "1234" });
  await expect(stageDesktopUploadSources(["/ok.txt", "/large.bin"])).rejects.toThrow("200 MiB");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["local_upload_file_info", "local_upload_file_info"]);
  expect(await disk.entries()).toEqual([]);
});

it("cancels between chunks and removes the partial disk snapshot", async () => {
  nativeFile(new Uint8Array(UPLOAD_CHUNK_BYTES + 17));
  const controller = new AbortController();
  disk.beforeWrite(() => controller.abort());
  await expect(stageDesktopUploadSources(["/original.bin"], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(await disk.entries()).toEqual(["miniq-upload-cache"]);
});

it("rejects short reads and removes the partial snapshot", async () => {
  invoke.mockResolvedValueOnce({ name: "changed.bin", size: 5, modified: "1234" })
    .mockResolvedValueOnce(new ArrayBuffer(2));
  await expect(stageDesktopUploadSources(["/changed.bin"])).rejects.toThrow("内容已变化");
  expect(await disk.entries()).toEqual(["miniq-upload-cache"]);
});
