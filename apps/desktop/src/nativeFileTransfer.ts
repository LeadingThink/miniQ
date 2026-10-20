import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { throwIfAborted } from "./abortSignal";

export interface NativeRemoteFile {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
}
export interface NativeSaveResult { status: "saved" | "shared" | "cancelled" }
export interface NativeUploadFile { id: string; name: string; size: number; sha256: string }
interface NativeFilesPlugin {
  save(options: NativeRemoteFile & { id: string }): Promise<NativeSaveResult>;
  cancel(options: { id: string }): Promise<void>;
  pickUpload(options: { id: string; kind: "files" | "photos"; limit: number }): Promise<{ files: NativeUploadFile[] }>;
  upload(options: { id: string; fileId: string; url: string }): Promise<{ status: "uploaded" | "cancelled" }>;
  releaseUpload(options: { ids: string[] }): Promise<void>;
  addListener(event: "progress", callback: (event: { id: string; received: number; total: number }) => void): Promise<PluginListenerHandle>;
}
const nativeFiles = registerPlugin<NativeFilesPlugin>("MiniqFiles");

/** Provider access remains open until every selected original is copied and
 * hashed in native private storage. Only metadata crosses the bridge. */
export async function pickNativeUploadFiles(kind: "files" | "photos", limit: number, signal?: AbortSignal): Promise<NativeUploadFile[]> {
  throwIfAborted(signal);
  const id = crypto.randomUUID();
  const cancel = () => { void nativeFiles.cancel({ id }).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const { files } = await nativeFiles.pickUpload({ id, kind, limit });
    if (signal?.aborted) {
      await releaseNativeUploadFiles(files.map((file) => file.id));
      throwIfAborted(signal);
    }
    return files;
  } catch (cause) {
    throwIfAborted(signal);
    throw cause;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function putNativeUploadFile(fileId: string, url: string, signal?: AbortSignal, onProgress?: (sent: number, total: number) => void): Promise<void> {
  throwIfAborted(signal);
  const id = crypto.randomUUID();
  const listener = await nativeFiles.addListener("progress", (event) => {
    if (event.id === id && !signal?.aborted) onProgress?.(event.received, event.total);
  });
  const cancel = () => { void nativeFiles.cancel({ id }).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    throwIfAborted(signal);
    const result = await nativeFiles.upload({ id, fileId, url });
    if (result.status === "cancelled") throw new DOMException("Request cancelled", "AbortError");
    if (result.status !== "uploaded") throw new Error("原件上传未完成，请重试");
    throwIfAborted(signal);
  } catch (cause) {
    throwIfAborted(signal);
    throw cause;
  } finally {
    signal?.removeEventListener("abort", cancel);
    // Releasing a bridge listener must not replace the upload outcome.
    await listener.remove().catch(() => {});
  }
}

export async function releaseNativeUploadFiles(ids: string[]): Promise<void> {
  if (ids.length) await nativeFiles.releaseUpload({ ids });
}

/** Streams signed object bytes to native temporary storage, verifies them, then
 * presents the OS destination picker. Never falls back to a WebView download. */
export async function saveRemoteFile(
  file: NativeRemoteFile,
  options: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {},
): Promise<NativeSaveResult> {
  if (options.signal?.aborted) return { status: "cancelled" };
  const id = crypto.randomUUID();
  const listener = await nativeFiles.addListener("progress", (event) => {
    if (event.id === id) options.onProgress?.(event.received, event.total);
  });
  const cancel = () => { void nativeFiles.cancel({ id }).catch(() => {}); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal?.aborted) return { status: "cancelled" };
    return await nativeFiles.save({ ...file, id });
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    await listener.remove().catch(() => {});
  }
}
