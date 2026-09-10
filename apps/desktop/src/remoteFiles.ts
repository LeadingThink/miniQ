import type { RpcClient } from "./rpc";
import type { LocalFilePreview, LocalPreviewKind } from "./localFiles";
import { decodeBase64 } from "./previewBinary";

export interface FileReadOptions {
  client?: Pick<RpcClient, "call" | "mode">;
  sessionId?: string | null;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  download?: boolean;
}

interface FileDescription {
  path: string;
  kind: LocalPreviewKind;
  mimeType: string;
  size: number;
  revision: string;
  chunkBytes: number;
  maxPreviewBytes: number;
}
interface FileChunk {
  offset: number;
  nextOffset: number;
  totalBytes: number;
  revision: string;
  done: boolean;
  dataBase64: string;
}

// Bounded independently of the server so a malformed response cannot exhaust
// mobile memory. No file content is requested before the user opens a file.
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function readRemoteFile(
  path: string,
  options: FileReadOptions,
): Promise<LocalFilePreview> {
  const { client, sessionId, signal, onProgress } = options;
  if (!client || !sessionId) throw new Error("请先连接桌面并打开一个会话");
  const description = await client.call<FileDescription>(
    "file.describe",
    { sessionId, path },
    { signal },
  );
  const { size, revision, kind } = description;
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof revision !== "string" ||
    !Number.isSafeInteger(description.chunkBytes) ||
    description.chunkBytes < 1 ||
    description.chunkBytes > 3 * 1024 * 1024
  ) {
    throw new Error("远程文件信息无效");
  }
  const file: LocalFilePreview = {
    ...description,
    content: null,
    dataBase64: null,
  };
  if (kind === "unsupported" && !options.download) return file;
  if (size > MAX_FILE_BYTES)
    throw new Error(
      "当前手机单文件预览与下载上限为 64 MB，请让 AI 生成较小的预览版或拆分文件",
    );
  const text = (kind === "text" || kind === "markdown") && !options.download;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let offset = 0;
  onProgress?.(0, size);
  while (offset < size) {
    signal?.throwIfAborted();
    const chunk = await client.call<FileChunk>(
      "file.read",
      { sessionId, path: description.path, revision, offset },
      { signal },
    );
    signal?.throwIfAborted();
    const bytes = decodeBase64(chunk.dataBase64);
    if (
      chunk.revision !== revision ||
      chunk.totalBytes !== size ||
      chunk.offset !== offset ||
      chunk.nextOffset !== offset + bytes.byteLength ||
      bytes.byteLength < 1 ||
      bytes.byteLength > description.chunkBytes ||
      chunk.nextOffset > size ||
      chunk.done !== (chunk.nextOffset === size) ||
      (!text && !chunk.done && bytes.byteLength % 3 !== 0)
    )
      throw new Error("文件传输不完整，请重新加载");
    parts.push(
      text ? decoder.decode(bytes, { stream: true }) : chunk.dataBase64,
    );
    offset = chunk.nextOffset;
    onProgress?.(offset, size);
  }
  if (text) {
    parts.push(decoder.decode());
    file.content = parts.join("");
  } else file.dataBase64 = parts.join("");
  return file;
}

export interface RemoteDirectory {
  path: string;
  parent: string | null;
  roots: string[];
  entries: {
    name: string;
    path: string;
    directory: boolean;
    size: number;
    unavailable?: boolean;
  }[];
  nextCursor: string | null;
}
