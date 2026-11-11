// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { ComposerUploads } from "./composerUploads";
import { uploadRemoteFile } from "./remoteTransfer";
import { pickUploadSources, releaseUploadSources, stageBrowserUploadSources, type RemoteUploadSource } from "./remoteUploadSource";
import type { RpcClient } from "./rpc";

vi.mock("./remoteTransfer", () => ({ uploadRemoteFile: vi.fn() }));
vi.mock("./remoteUploadSource", () => ({
  pickUploadSources: vi.fn(), stageBrowserUploadSources: vi.fn(),
  releaseUploadSources: vi.fn(async (sources: RemoteUploadSource[]) => { await Promise.all(sources.map(source => source.release())); }),
}));
const cached = (id: string): RemoteUploadSource => ({ kind: "native", id, name: `${id}.heic`, size: 4, sha256: "a".repeat(64), release: vi.fn(async () => {}) });
const receipt = (name: string) => ({ status: "completed" as const, path: `/original/inbox/${name}`, size: 4, sha256: "a".repeat(64) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let first: RemoteUploadSource;
let second: RemoteUploadSource;
let queue: ComposerUploads;
let client: RpcClient;
beforeEach(() => {
  vi.clearAllMocks();
  first = cached("first"); second = cached("second");
  client = { call: vi.fn() } as unknown as RpcClient;
  queue = new ComposerUploads(client, { sessionId: "original" });
  queue.onAttach = vi.fn();
  vi.mocked(pickUploadSources).mockReset().mockResolvedValue([first, second]);
  vi.mocked(stageBrowserUploadSources).mockReset().mockResolvedValue([first, second]);
  vi.mocked(uploadRemoteFile).mockReset().mockImplementation(async (_client, _scope, source) => receipt(source.name));
});

it("uses the original picker and releases each confirmed source", async () => {
  await queue.select("photos");
  expect(pickUploadSources).toHaveBeenCalledWith("photos", expect.any(AbortSignal));
  expect(stageBrowserUploadSources).not.toHaveBeenCalled();
  expect(vi.mocked(uploadRemoteFile).mock.calls.map(args => args.slice(0, 3))).toEqual([
    [client, { sessionId: "original" }, first], [client, { sessionId: "original" }, second],
  ]);
  expect(first.release).toHaveBeenCalledOnce();
  expect(second.release).toHaveBeenCalledOnce();
  expect(queue.onAttach).toHaveBeenCalledTimes(2);
  expect(queue.getSnapshot()).toEqual([]);
});

it("stages the whole browser selection before the first network upload", async () => {
  const staged = deferred<RemoteUploadSource[]>();
  vi.mocked(stageBrowserUploadSources).mockReturnValueOnce(staged.promise);
  const originals = [new File(["x"], "first.heic"), new File(["y"], "second.heic")];
  const selected = queue.select(originals);
  expect(queue.getSnapshot().map(item => item.name)).toEqual(["first.heic", "second.heic"]);
  expect(stageBrowserUploadSources).toHaveBeenCalledWith(originals, expect.any(AbortSignal));
  expect(uploadRemoteFile).not.toHaveBeenCalled();
  staged.resolve([first, second]);
  await selected;
  expect(uploadRemoteFile).toHaveBeenCalledTimes(2);
});

it("cancels a pending picker and releases late sources without uploading", async () => {
  const picked = deferred<RemoteUploadSource[]>();
  vi.mocked(pickUploadSources).mockReturnValueOnce(picked.promise);
  const selected = queue.select("files");
  const waiting = queue.wait(new AbortController().signal);
  queue.pause();
  expect(await waiting).toBe(false);
  expect(vi.mocked(pickUploadSources).mock.calls[0][1]?.aborted).toBe(true);
  picked.resolve([first, second]);
  await selected;
  expect(uploadRemoteFile).not.toHaveBeenCalled();
  expect(queue.onAttach).not.toHaveBeenCalled();
  expect(releaseUploadSources).toHaveBeenCalledWith([first, second]);
});

it("retains a failed original for retry and uploads the other files independently", async () => {
  vi.mocked(uploadRemoteFile).mockRejectedValueOnce(new Error("桌面离线"));
  await queue.select("files");
  expect(queue.getSnapshot()).toEqual([expect.objectContaining({ name: "first.heic", state: "failed", error: "桌面离线" })]);
  expect(first.release).not.toHaveBeenCalled();
  expect(second.release).toHaveBeenCalledOnce();
  expect(await queue.wait(new AbortController().signal)).toBe(false);
  queue.retry(queue.getSnapshot()[0].id);
  expect(await queue.wait(new AbortController().signal)).toBe(true);
  expect(pickUploadSources).toHaveBeenCalledOnce();
  expect(first.release).toHaveBeenCalledOnce();
  expect(queue.onAttach).toHaveBeenLastCalledWith(["/original/inbox/first.heic"]);
});

it("removes one preparing file without cancelling the other originals", async () => {
  const staged = deferred<RemoteUploadSource[]>();
  vi.mocked(stageBrowserUploadSources).mockReturnValueOnce(staged.promise);
  const selected = queue.select([new File(["x"], "first.heic"), new File(["y"], "second.heic")]);
  queue.remove(queue.getSnapshot()[0].id);
  expect(vi.mocked(stageBrowserUploadSources).mock.calls[0][1]?.aborted).toBe(false);
  staged.resolve([first, second]);
  await selected;
  expect(uploadRemoteFile).toHaveBeenCalledOnce();
  expect(vi.mocked(uploadRemoteFile).mock.calls[0][2]).toBe(second);
  expect(first.release).toHaveBeenCalledOnce();
});

it("releases a removed queued source even when the batch is then paused", async () => {
  vi.mocked(uploadRemoteFile).mockImplementationOnce((_client, _scope, _source, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
  }));
  const selected = queue.select("files");
  await vi.waitFor(() => expect(uploadRemoteFile).toHaveBeenCalledOnce());
  queue.remove(queue.getSnapshot()[1].id);
  queue.pause();
  await selected;
  expect(second.release).toHaveBeenCalledOnce();
  expect(first.release).not.toHaveBeenCalled();
  expect(queue.getSnapshot()[0].state).toBe("failed");
  queue.remove(queue.getSnapshot()[0].id);
  expect(first.release).toHaveBeenCalledOnce();
});

it("retries a failed native picker with its original kind", async () => {
  vi.mocked(pickUploadSources).mockRejectedValueOnce(new Error("权限已失效"));
  await queue.select("photos");
  expect(queue.pendingCount).toBe(1);
  queue.retry(queue.getSnapshot()[0].id);
  expect(queue.pendingCount).toBe(1);
  expect(await queue.wait(new AbortController().signal)).toBe(true);
  expect(pickUploadSources).toHaveBeenLastCalledWith("photos", expect.any(AbortSignal));
});

it("does not complete a waiting send when the native selection is cancelled", async () => {
  const picked = deferred<RemoteUploadSource[]>();
  vi.mocked(pickUploadSources).mockReturnValueOnce(picked.promise);
  const selected = queue.select("files");
  const waiting = queue.wait(new AbortController().signal);
  picked.resolve([]);
  await selected;
  expect(await waiting).toBe(false);
  expect(queue.getSnapshot()).toEqual([]);
});

it("stages a selection larger than ten and reports every pending file", async () => {
  const sources = Array.from({ length: 12 }, (_, index) => cached(`file-${index}`));
  const staged = deferred<RemoteUploadSource[]>();
  vi.mocked(stageBrowserUploadSources).mockReturnValueOnce(staged.promise);
  const selected = queue.select(Array.from({ length: 12 }, (_, index) => new File(["x"], `file-${index}.heic`)));
  expect(queue.pendingCount).toBe(12);
  staged.resolve(sources);
  await selected;
  expect(queue.pendingCount).toBe(0);
  expect(queue.onAttach).toHaveBeenCalledTimes(12);
});

it("stops waiting immediately on failure even while another file is uploading", async () => {
  const uploading = deferred<ReturnType<typeof receipt>>();
  vi.mocked(uploadRemoteFile).mockRejectedValueOnce(new Error("网络错误")).mockReturnValueOnce(uploading.promise);
  const selected = queue.select("files");
  expect(await queue.wait(new AbortController().signal)).toBe(false);
  uploading.resolve(receipt("second.heic"));
  await selected;
});
