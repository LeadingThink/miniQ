import { afterEach, expect, it, vi } from "vitest";
import { deriveRemoteIdentity, encryptRemotePayload } from "./remoteCrypto";
import { readRemoteBlob } from "./remoteBlob";

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const {encryptionKey} = await deriveRemoteIdentity("fixture-only");
  const expected = {id:"request", result:"完整结果".repeat(1000)};
  const encrypted = await encryptRemotePayload(encryptionKey, expected);
  const bytes = Buffer.from(encrypted.ciphertext, "base64url");
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  const descriptor = {url:"https://s3.cn-south-1.qiniucs.com/private/test", expiresAt:Date.now() + 300000, bytes:bytes.length, sha256:digest, nonce:encrypted.nonce};
  return {encryptionKey, expected, bytes, descriptor};
}

it("validates ciphertext before decrypting private object results", async () => {
  const data = await fixture();
  const fetcher = vi.fn(async () => new Response(data.bytes));
  vi.stubGlobal("fetch", fetcher);
  await expect(readRemoteBlob(data.encryptionKey, data.descriptor, new AbortController().signal)).resolves.toEqual(data.expected);
  expect(fetcher.mock.calls[0]).toHaveLength(2);
});

it("rejects corrupted, incomplete and expired object responses", async () => {
  const data = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(data.bytes)));
  await expect(readRemoteBlob(data.encryptionKey, {...data.descriptor, sha256:"wrong"}, new AbortController().signal)).rejects.toThrow("完整性");
  await expect(readRemoteBlob(data.encryptionKey, {...data.descriptor, expiresAt:0}, new AbortController().signal)).rejects.toThrow("过期");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(data.bytes.subarray(0, 100))));
  await expect(readRemoteBlob(data.encryptionKey, data.descriptor, new AbortController().signal)).rejects.toThrow("不完整");
});

it("refuses cross-origin injection and respects cancellation", async () => {
  const data = await fixture();
  const fetcher = vi.fn(async () => new Response(data.bytes));
  vi.stubGlobal("fetch", fetcher);
  for (const url of ["http://s3.cn-south-1.qiniucs.com/key", "https://qiniucs.com.evil.invalid/key", "https://localhost/key"]) {
    await expect(readRemoteBlob(data.encryptionKey, {...data.descriptor, url}, new AbortController().signal)).rejects.toThrow("地址");
  }
  expect(fetcher).not.toHaveBeenCalled();
  const request = new AbortController();
  request.abort();
  await expect(readRemoteBlob(data.encryptionKey, data.descriptor, request.signal)).rejects.toMatchObject({name:"AbortError"});
});
