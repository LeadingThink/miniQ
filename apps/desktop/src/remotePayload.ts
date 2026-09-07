import { decodeBase64, MAX_DECODED_BYTES, readBounded, readRemoteBlob } from "./remoteBlob";
type Payload = Record<string, unknown>;

interface Transfer {
  id: string;
  requestId: string;
  index: number;
  totalBytes: number;
  receivedBytes: number;
  decoder: TextDecoder;
  text: string[];
}

// One reader per socket: disconnecting discards incomplete transfers.
export class RemotePayloadReader {
  private transfers = new Map<string, Transfer>();
  private cancelled = new Set<string>();
  private downloads = new Map<string, AbortController>();
  constructor(private key?: CryptoKey, private isActive: (id: string) => boolean = () => true) {}

  cancelRequest(id: string) {
    this.cancelled.add(id);
    if (this.cancelled.size > 2048) this.cancelled.delete(this.cancelled.values().next().value!);
    this.downloads.get(id)?.abort();
    for (const [key, transfer] of this.transfers) {
      if (transfer.requestId === id) this.transfers.delete(key);
    }
  }

  dispose() {
    for (const download of this.downloads.values()) download.abort();
    this.downloads.clear();
    this.transfers.clear();
    this.cancelled.clear();
  }

  async readAsync(payload: Payload): Promise<Payload[]> {
    const id = String(payload.requestId ?? payload.id ?? "");
    if (id && (this.cancelled.has(id) || !this.isActive(id))) return [];
    if (payload.type === "remote_blob") {
      if (!this.key || !id) throw new Error("远程对象引用无效");
      const request = new AbortController();
      this.downloads.get(id)?.abort();
      this.downloads.set(id, request);
      try {
        const result = await this.readAsync(asPayload(await readRemoteBlob(this.key, payload, request.signal)));
        if (result.some((value) => String(value.id) !== id)) throw new Error("远程对象请求不匹配");
        return request.signal.aborted ? [] : result;
      } finally { if (this.downloads.get(id) === request) this.downloads.delete(id); }
    }
    const result: Payload[] = [];
    for (const item of this.read(payload)) {
      if (item.type !== "remote_compressed") { result.push(item); continue; }
      if (item.encoding !== "gzip" || typeof item.data !== "string") throw new Error("远程压缩消息无效");
      const bytes = decodeBase64(item.data);
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
      const decodedBytes = await readBounded(stream, item.uncompressedBytes as number);
      const decoded = asPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes)));
      result.push(...this.read(decoded));
    }
    return result;
  }

  read(payload: Payload): Payload[] {
    if (payload.type === "remote_chunk") return this.readChunk(payload);
    if (payload.type === "remote_batch") {
      if (!Array.isArray(payload.items)) throw new Error("远程事件批次无效");
      return payload.items.map(asPayload);
    }
    return [payload];
  }

  private readChunk(payload: Payload): Payload[] {
    const { transferId, index, totalBytes, data } = payload;
    const requestId = String(payload.requestId ?? "");
    if (requestId && (this.cancelled.has(requestId) || !this.isActive(requestId))) return [];
    if (
      typeof transferId !== "string" ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(totalBytes) ||
      (totalBytes as number) <= 0 ||
      (totalBytes as number) > MAX_DECODED_BYTES ||
      typeof data !== "string"
    ) {
      throw new Error("远程分块信息无效");
    }
    let transfer = this.transfers.get(transferId);
    if (!transfer) {
      if (this.transfers.size >= 32) throw new Error("远程并发传输过多");
      if (index !== 0) throw new Error("远程分块缺少起始块");
      transfer = {
        id: transferId,
        requestId,
        index: 0,
        totalBytes: totalBytes as number,
        receivedBytes: 0,
        decoder: new TextDecoder("utf-8", { fatal: true }),
        text: [],
      };
      this.transfers.set(transferId, transfer);
    }
    if (
      transfer.id !== transferId ||
      transfer.index !== index ||
      transfer.totalBytes !== totalBytes
      || transfer.requestId !== requestId
    ) {
      throw new Error("远程分块顺序不一致");
    }
    const bytes = decodeBase64(data);
    if (
      !bytes.length ||
      transfer.receivedBytes + bytes.length > transfer.totalBytes
    ) {
      throw new Error("远程分块长度无效");
    }
    transfer.receivedBytes += bytes.length;
    transfer.index++;
    transfer.text.push(transfer.decoder.decode(bytes, { stream: true }));
    if (transfer.receivedBytes !== transfer.totalBytes) return [];
    transfer.text.push(transfer.decoder.decode());
    this.transfers.delete(transferId);
    return this.read(asPayload(JSON.parse(transfer.text.join(""))));
  }
}

function asPayload(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("远程消息无效");
  return value as Payload;
}
