import type { RpcClient } from "./rpc";
import { throwIfAborted } from "./abortSignal";
import type { LocalFilePreview, LocalPreviewKind } from "./localFiles";
import { downloadRemoteFile, prepareRemotePreview, readRemoteRange, SMALL_RPC_FILE_BYTES, type RemotePreviewSource } from "./remoteTransfer";
import { canFallbackRemoteFile } from "./remoteFileErrors";
import { CONNECTION_FILE_LIMIT, readConnectionFile, type ConnectionFileDescription } from "./remoteConnectionFile";
import { readSshFile } from "./sshFileDownload";

export interface FileReadOptions {
  client?: Pick<RpcClient, "call" | "mode"> & Partial<Pick<RpcClient, "sshHost" | "targetDeviceId">>;
  sessionId?: string | null;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  onTransport?: (transport: "storage" | "connection") => void;
  /** Reserve aggregate memory before downloading a resource in a bundle. */
  reserveBytes?: (size: number) => void;
  download?: boolean;
}
interface FileDescription extends ConnectionFileDescription {
  kind: LocalPreviewKind;
  maxPreviewBytes: number;
}
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export async function readRemoteFile(path: string, options: FileReadOptions): Promise<LocalFilePreview> {
  const { client, sessionId, signal, onProgress } = options;
  if (!client || !sessionId) throw new Error("请先连接桌面并打开一个会话");
  throwIfAborted(signal);
  const description = await client.call<FileDescription>("file.describe", { sessionId, path }, { signal });
  const { size, revision, kind } = description;
  throwIfAborted(signal);
  if (!Number.isSafeInteger(size) || size < 0 || typeof revision !== "string" ||
      !Number.isSafeInteger(description.chunkBytes) || description.chunkBytes < 1 || description.chunkBytes > 3 * 1024 * 1024) {
    throw new Error("远程文件信息无效");
  }
  const file: LocalFilePreview = { ...description, content: null, dataBase64: null, blob: null };
  if (kind === "unsupported" && !options.download) return file;
  if (size > MAX_FILE_BYTES) throw new Error("当前手机单文件预览与下载上限为 200 MB，请让 AI 生成较小的预览版或拆分文件");
  options.reserveBytes?.(size);
  if (client.sshHost) return readSshFile(file, revision, options);
  const text = (kind === "text" || kind === "markdown") && !options.download;
  const transport = (value: "storage" | "connection") => { file.transport = value; options.onTransport?.(value); };
  const connection = async (cause: unknown): Promise<Blob> => {
    throwIfAborted(signal);
    if (!canFallbackRemoteFile(cause) || !text || size > CONNECTION_FILE_LIMIT) throw cause;
    const blob = await readConnectionFile(description, { ...options, onTransport: transport });
    return blob;
  };
  const finish = async (blob: Blob): Promise<LocalFilePreview> => {
    if (text) file.content = new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer());
    else file.blob = blob;
    file.remoteSource = undefined;
    file.textPage = undefined;
    throwIfAborted(signal);
    return { ...file };
  };
  const preview = async (): Promise<RemotePreviewSource> => {
    transport("storage");
    const source = await prepareRemotePreview(client, sessionId, description.path, revision, size, signal);
    return source;
  };
  try {
    if (!options.download && !options.reserveBytes && ["pdf", "image", "audio", "video"].includes(kind)) {
      file.remoteSource = await preview();
      return file;
    }
    if (text && size > SMALL_RPC_FILE_BYTES && !options.reserveBytes) {
      let source = await preview();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let offset = 0;
      let busy = false;
      const next = async (): Promise<LocalFilePreview> => {
        if (busy) throw new Error("正在读取下一段");
        busy = true;
        try {
          throwIfAborted(signal);
          const result = await readRemoteRange(source, offset, SMALL_RPC_FILE_BYTES, signal);
          source = result.source;
          const bytes = result.bytes;
          throwIfAborted(signal);
          offset += bytes.length;
          file.content = decoder.decode(bytes, { stream: offset < size });
          file.textPage = { end: offset, total: size, next: offset < size ? next : undefined };
          return { ...file };
        } finally { busy = false; }
      };
      // Storage failures propagate: large text is outside file.read's contract.
      return next();
    }
    transport("storage");
    const prepared = await downloadRemoteFile(client, sessionId, description.path, revision, signal, onProgress);
    if (prepared.size !== size) throw new Error("文件大小已变化，请重新加载");
    return finish(prepared.blob.slice(0, size, description.mimeType));
  } catch (cause) {
    return finish(await connection(cause));
  }
}

export interface RemoteDirectory {
  path: string;
  parent: string | null;
  roots: string[];
  entries: { name: string; path: string; directory: boolean; size: number; unavailable?: boolean }[];
  nextCursor: string | null;
}
