const CHUNK_BYTES = 768 * 1024;

/** Match the daemon's remote_chunk envelope in the upload direction too. */
export function* remoteUploadFrames(payload: unknown): Generator<unknown> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length <= CHUNK_BYTES) { yield payload; return; }
  const transferId = crypto.randomUUID();
  const requestId = (payload as { id?: string }).id;
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    let binary = "";
    for (let index = 0; index < chunk.length; index += 0x8000) {
      binary += String.fromCharCode(...chunk.subarray(index, index + 0x8000));
    }
    yield { type: "remote_chunk", transferId, requestId, index: offset / CHUNK_BYTES,
      totalBytes: bytes.length, data: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") };
  }
}
