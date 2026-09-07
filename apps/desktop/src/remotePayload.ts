type Payload = Record<string, unknown>;

interface Transfer {
  id: string;
  index: number;
  totalBytes: number;
  receivedBytes: number;
  decoder: TextDecoder;
  text: string[];
}

// One reader per socket: disconnecting discards incomplete transfers.
export class RemotePayloadReader {
  private transfer: Transfer | null = null;

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
    if (
      typeof transferId !== "string" ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(totalBytes) ||
      (totalBytes as number) <= 0 ||
      typeof data !== "string"
    ) {
      throw new Error("远程分块信息无效");
    }
    if (!this.transfer) {
      if (index !== 0) throw new Error("远程分块缺少起始块");
      this.transfer = {
        id: transferId,
        index: 0,
        totalBytes: totalBytes as number,
        receivedBytes: 0,
        decoder: new TextDecoder("utf-8", { fatal: true }),
        text: [],
      };
    }
    const transfer = this.transfer;
    if (
      transfer.id !== transferId ||
      transfer.index !== index ||
      transfer.totalBytes !== totalBytes
    ) {
      throw new Error("远程分块顺序不一致");
    }
    const binary = atob(data.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
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
    this.transfer = null;
    return this.read(asPayload(JSON.parse(transfer.text.join(""))));
  }
}

function asPayload(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("远程消息无效");
  return value as Payload;
}
