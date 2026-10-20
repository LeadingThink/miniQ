/// <reference lib="dom.asynciterable" />
import { Capacitor } from "@capacitor/core";
import { throwIfAborted } from "./abortSignal";
import { Sha256 } from "./incrementalSha256";

export const MAX_REMOTE_FILE_BYTES = 200 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
interface UploadMetadata { name: string; size: number; sha256: string; release: () => Promise<void> }
export type RemoteUploadSource = UploadMetadata & (
  { kind: "browser"; file: File } | { kind: "native"; id: string }
);
export const usesNativeUploadPicker = () => Capacitor.isNativePlatform();

export function validateUploadSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_REMOTE_FILE_BYTES)
    throw new Error("单个文件不能超过 200 MiB");
}

export async function pickUploadSources(kind: "files" | "photos", limit: number, signal?: AbortSignal): Promise<RemoteUploadSource[]> {
  const { pickNativeUploadFiles, releaseNativeUploadFiles } = await import("./nativeFileTransfer");
  const files = await pickNativeUploadFiles(kind, limit, signal);
  try {
    if (files.length > limit) throw new Error("所选文件数量超过附件上限");
    return files.map((file) => {
      validateUploadSize(file.size);
      if (!file.id || !file.name || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("本机文件缓存信息无效，请重新选择");
      return { ...file, kind: "native" as const, release: once(() => releaseNativeUploadFiles([file.id])) };
    });
  } catch (cause) {
    await releaseNativeUploadFiles(files.map((file) => file.id));
    throw cause;
  }
}

function once(action: () => Promise<void>): () => Promise<void> {
  let released: Promise<void> | undefined;
  return () => released ??= action();
}

/** Snapshot before queuing network work. The provider File is read once, in
 * bounded slices; PUT retries never reopen its permission lease. */
export async function stageBrowserUploadSources(files: readonly File[], signal?: AbortSignal): Promise<RemoteUploadSource[]> {
  throwIfAborted(signal);
  for (const file of files) validateUploadSize(file.size);
  if (!files.length) return [];
  if (!globalThis.navigator?.storage?.getDirectory) throw new Error("此浏览器无法安全暂存所选文件，请使用 miniQ 手机应用或支持文件缓存的浏览器");
  const sources: RemoteUploadSource[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("miniq-upload-cache", { create: true });
    // Files left by a terminated page have no owner to release them. Expire only
    // our timestamped cache entries, well beyond any upload ticket's lifetime.
    for await (const name of directory.keys()) {
      const stamp = /^(\d{13})-[a-f0-9-]{36}$/.exec(name)?.[1];
      if (stamp && Date.now() - Number(stamp) > 24 * 60 * 60 * 1000) await directory.removeEntry(name).catch(() => {});
    }
    for (const file of files) sources.push(await stageFile(directory, file, signal));
    throwIfAborted(signal);
    return sources;
  } catch (cause) {
    await releaseUploadSources(sources);
    throwIfAborted(signal);
    if (cause instanceof Error && cause.name === "NotReadableError")
      throw new Error("无法读取所选文件，请先在手机中下载原件，再重新选择上传", { cause });
    if (cause instanceof Error && cause.name === "QuotaExceededError")
      throw new Error("文件暂存空间不足，请释放设备空间后重新选择", { cause });
    throw cause;
  }
}

async function stageFile(directory: FileSystemDirectoryHandle, file: File, signal?: AbortSignal): Promise<RemoteUploadSource> {
  throwIfAborted(signal);
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const release = once(() => directory.removeEntry(id));
  const handle = await directory.getFileHandle(id, { create: true });
  let writable: FileSystemWritableFileStream | undefined;
  try {
    writable = await handle.createWritable();
    const hash = new Sha256();
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      throwIfAborted(signal);
      if (bytes.byteLength !== end - offset) throw new Error("所选文件内容已变化，请重新选择");
      hash.update(bytes);
      await writable.write(bytes);
    }
    throwIfAborted(signal);
    await writable.close();
    writable = undefined;
    const cached = await handle.getFile();
    if (cached.size !== file.size) throw new Error("文件暂存不完整，请重新选择");
    return { kind: "browser", name: file.name, size: file.size, sha256: hash.hex(), file: cached, release };
  } catch (cause) {
    await writable?.abort().catch(() => {});
    await release().catch(() => {});
    throw cause;
  }
}

export async function releaseUploadSources(sources: readonly RemoteUploadSource[]): Promise<void> {
  // A cache cleanup failure must never replace a confirmed desktop receipt.
  await Promise.allSettled(sources.map((source) => source.release()));
}
