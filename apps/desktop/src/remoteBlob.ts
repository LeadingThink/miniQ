export const MAX_DECODED_BYTES = 256 * 1024 * 1024;

export async function readBounded(stream: ReadableStream<Uint8Array>, expected: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_DECODED_BYTES) throw new Error("远程数据长度无效");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected) throw new Error("远程数据超出声明长度");
      chunks.push(value);
    }
    signal?.throwIfAborted();
    if (size !== expected) throw new Error("远程数据不完整");
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readRemoteBlob(key: CryptoKey, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const url = new URL(String(payload.url));
  if (url.protocol !== "https:" || !url.hostname.endsWith(".qiniucs.com") || url.username || url.password) throw new Error("远程对象地址无效");
  if (typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) throw new Error("下载链接已过期，请重试");
  const size = payload.bytes;
  if (!Number.isSafeInteger(size) || (size as number) < 16 || (size as number) > 64 * 1024 * 1024) throw new Error("远程对象长度无效");
  const response = await fetch(url, { signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`下载失败 (${response.status})，请重试`);
  const bytes = await readBounded(response.body, size as number, signal);
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== payload.sha256) throw new Error("远程对象完整性验证失败");
  const nonce = decodeBase64(String(payload.nonce));
  if (nonce.length !== 12) throw new Error("远程对象 nonce 无效");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> }, key, bytes as Uint8Array<ArrayBuffer>);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}
