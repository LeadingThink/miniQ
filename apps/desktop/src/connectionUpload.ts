import { throwIfAborted } from "./abortSignal";
import type { RpcClient } from "./rpc";
import type { RemoteUploadSource } from "./remoteUploadSource";
import type { RemoteUploadScope } from "./remoteTransfer";

export interface ConnectionUpload {
  transport: "connection";
  transferId: string;
  expiresAt: number;
  chunkBytes: number;
}

/** SSH uploads use the authenticated RPC connection, with one bounded block in flight. */
export async function writeConnectionUpload(
  client: Pick<RpcClient, "call">,
  scope: RemoteUploadScope,
  ticket: ConnectionUpload,
  file: RemoteUploadSource,
  signal?: AbortSignal,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  if (typeof ticket.transferId !== "string" || !ticket.transferId ||
      !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= Date.now() ||
      !Number.isSafeInteger(ticket.chunkBytes) || ticket.chunkBytes < 1 || ticket.chunkBytes > 256 * 1024)
    throw new Error("文件上传传输信息无效");
  for (let offset = 0; offset < file.size;) {
    throwIfAborted(signal);
    if (ticket.expiresAt <= Date.now()) throw new Error("文件上传已过期，请重试");
    const length = Math.min(ticket.chunkBytes, file.size - offset);
    let dataBase64: string;
    if (file.kind === "native") {
      const { readNativeUploadChunk } = await import("./nativeFileTransfer");
      dataBase64 = await readNativeUploadChunk(file.id, offset, length, signal);
    } else {
      const bytes = new Uint8Array(await file.file.slice(offset, offset + length).arrayBuffer());
      if (bytes.length !== length) throw new Error("文件暂存不完整，请重新选择");
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      dataBase64 = btoa(binary);
    }
    throwIfAborted(signal);
    const result = await client.call<{ nextOffset: number }>("file.upload.write", {
      ...scope, transferId: ticket.transferId, offset, dataBase64,
    }, { timeoutMs: 600000 });
    throwIfAborted(signal);
    if (result?.nextOffset !== offset + length) throw new Error("文件分块回执校验失败");
    offset += length;
    onProgress?.(offset, file.size);
  }
}
