import { throwIfAborted } from "./abortSignal";
import { decodeBase64 } from "./previewBinary";
import { Sha256 } from "./incrementalSha256";
import type { LocalFilePreview } from "./localFiles";
import type { FileReadOptions } from "./remoteFiles";
import { MAX_REMOTE_FILE_BYTES, SMALL_RPC_FILE_BYTES } from "./remoteTransfer";

interface Download {
  transport: "connection";
  transferId: string;
  revision: string;
  size: number;
  sha256: string;
  expiresAt: number;
  chunkBytes: number;
}
interface Block {
  offset: number;
  nextOffset: number;
  totalBytes: number;
  revision: string;
  dataBase64: string;
  done: boolean;
}

/** SSH has a prepared RPC byte stream. No signed URL, storage request or error fallback. */
export async function readSshFile(file: LocalFilePreview, revision: string, options: FileReadOptions): Promise<LocalFilePreview> {
  const { client, sessionId, signal, onProgress, onTransport } = options;
  if (!client || !sessionId) throw new Error("请先连接 SSH 主机并打开会话");
  const target = client.targetDeviceId;
  const current = () => client.targetDeviceId === target;
  const check = () => {
    throwIfAborted(signal);
    if (!current()) throw new Error("目标电脑已变化，请重新打开文件");
  };
  check();
  file.transport = "connection";
  onTransport?.("connection");
  // Own the prepare response even after cancellation so the late handle can be closed.
  const ticket = await client.call<Download>("file.download.prepare", { sessionId, path: file.path, revision }, { timeoutMs: 600000 });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", release);
    if (current() && typeof ticket?.transferId === "string" && ticket.transferId) {
      void client.call("file.transfer.cancel", { sessionId, transferId: ticket.transferId }).catch(() => {});
    }
  };
  const hash = new Sha256();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  let busy = false;
  const text = !options.download && ["text", "markdown"].includes(file.kind);
  const paged = text && file.size > SMALL_RPC_FILE_BYTES && !options.reserveBytes;
  const next = async (): Promise<LocalFilePreview> => {
    if (busy) throw new Error("正在读取下一段");
    if (released) { check(); throw new Error("文件下载已结束，请重新打开"); }
    busy = true;
    try {
      const parts: BlobPart[] = [];
      const contents: string[] = [];
      do {
        check();
        if (ticket.expiresAt <= Date.now()) throw new Error("文件下载已过期，请重新打开");
        if (offset === file.size) break;
        const length = Math.min(ticket.chunkBytes, file.size - offset);
        const block = await client.call<Block>("file.download.read", {
          sessionId, transferId: ticket.transferId, offset, length,
        }, { signal });
        check();
        if (typeof block?.dataBase64 !== "string" || block.dataBase64.length > 4 * Math.ceil(length / 3))
          throw new Error("文件传输信息无效");
        const bytes = new Uint8Array(decodeBase64(block.dataBase64));
        if (block.offset !== offset || bytes.byteLength !== length || block.nextOffset !== offset + length ||
            block.totalBytes !== file.size || block.revision !== revision || block.done !== (offset + length === file.size))
          throw new Error("文件传输不完整，请重新加载");
        hash.update(bytes);
        offset = block.nextOffset;
        if (text) contents.push(decoder.decode(bytes, { stream: offset < file.size }));
        else parts.push(new Blob([bytes]));
        onProgress?.(offset, file.size);
      } while (!paged && offset < file.size);
      check();
      if (offset === file.size) {
        if (hash.hex() !== ticket.sha256) throw new Error("文件完整性校验失败");
        release();
      }
      if (text) file.content = contents.join("");
      else file.blob = new Blob(parts, { type: file.mimeType });
      if (paged) file.textPage = { end: offset, total: file.size, next: offset < file.size ? next : undefined };
      return { ...file };
    } catch (cause) {
      release();
      throw cause;
    } finally { busy = false; }
  };
  try {
    check();
    if (ticket?.transport !== "connection" || typeof ticket.transferId !== "string" || !ticket.transferId ||
        ticket.revision !== revision || ticket.size !== file.size || !Number.isSafeInteger(ticket.size) ||
        ticket.size < 0 || ticket.size > MAX_REMOTE_FILE_BYTES || !/^[a-f0-9]{64}$/.test(ticket.sha256) ||
        !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= Date.now() ||
        !Number.isSafeInteger(ticket.chunkBytes) || ticket.chunkBytes < 1 || ticket.chunkBytes > SMALL_RPC_FILE_BYTES)
      throw new Error("SSH 文件传输信息无效");
    signal?.addEventListener("abort", release, { once: true });
    onProgress?.(0, file.size);
    return await next();
  } catch (cause) {
    release();
    throw cause;
  }
}
