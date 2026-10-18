import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface NativeRemoteFile {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
}
export interface NativeSaveResult { status: "saved" | "shared" | "cancelled" }
interface NativeFilesPlugin {
  save(options: NativeRemoteFile & { id: string }): Promise<NativeSaveResult>;
  cancel(options: { id: string }): Promise<void>;
  addListener(event: "progress", callback: (event: { id: string; received: number; total: number }) => void): Promise<PluginListenerHandle>;
}
const nativeFiles = registerPlugin<NativeFilesPlugin>("MiniqFiles");

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
    await listener.remove();
  }
}
