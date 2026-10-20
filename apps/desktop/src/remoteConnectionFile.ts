import { throwIfAborted } from "./abortSignal";
import { decodeBase64 } from "./previewBinary";
import type { FileReadOptions } from "./remoteFiles";
// Keep aligned with the existing daemon file.read contract.
export const CONNECTION_FILE_LIMIT = 256 * 1024;
export interface ConnectionFileDescription { path: string; size: number; revision: string; chunkBytes: number; mimeType: string; kind: string }
interface FileChunk { offset: number; nextOffset: number; totalBytes: number; revision: string; done: boolean; dataBase64: string }
/** Uses the existing encrypted RPC connection and validates every chunk. */
export async function readConnectionFile(description: ConnectionFileDescription, options: FileReadOptions): Promise<Blob> {
  const { client, sessionId, signal, onProgress } = options;
  if (description.size > CONNECTION_FILE_LIMIT || !["text", "markdown"].includes(description.kind) || options.download) {
    throw new Error("当前连接仅支持不超过 256 KiB 的文本预览，请恢复文件存储服务后重试");
  }
  throwIfAborted(signal);
  options.onTransport?.("connection");
  const parts: BlobPart[] = [];
  let offset = 0;
  onProgress?.(0, description.size);
  while (offset < description.size) {
    throwIfAborted(signal);
    const chunk = await client!.call<FileChunk>("file.read", { sessionId, path: description.path, revision: description.revision, offset }, { signal });
    throwIfAborted(signal);
    const bytes = decodeBase64(chunk.dataBase64);
    if (chunk.revision !== description.revision || chunk.totalBytes !== description.size || chunk.offset !== offset ||
        chunk.nextOffset !== offset + bytes.byteLength || bytes.byteLength < 1 || bytes.byteLength > description.chunkBytes ||
        chunk.nextOffset > description.size || chunk.done !== (chunk.nextOffset === description.size)) throw new Error("文件传输不完整，请重新加载");
    parts.push(new Blob([bytes]));
    offset = chunk.nextOffset;
    onProgress?.(offset, description.size);
  }
  throwIfAborted(signal);
  return new Blob(parts, { type: description.mimeType });
}
