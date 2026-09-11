import { expect, it } from "vitest";
import { remoteUploadFrames } from "./remoteUpload";
import { RemotePayloadReader } from "./remotePayload";
import { decryptRemotePayload, deriveRemoteIdentity, encryptRemotePayload } from "./remoteCrypto";

it("sends a three-minute recording below the relay wire limit without losing bytes", async () => {
  const request = { jsonrpc: "2.0", id: "voice-final", method: "voice.transcribe", params: {
    audioBase64: "a".repeat(180 * 32_000 * 4 / 3), filename: "中文录音.wav", preview: false,
  } };
  const identity = await deriveRemoteIdentity("test-key");
  const reader = new RemotePayloadReader(); const result: unknown[] = [];
  let count = 0;
  for (const frame of remoteUploadFrames(request)) {
    const encrypted = await encryptRemotePayload(identity.encryptionKey, frame);
    expect(new TextEncoder().encode(JSON.stringify({type: "frame", target: "desktop", ...encrypted})).length).toBeLessThan(2 * 1024 * 1024);
    const decoded = await decryptRemotePayload<Record<string, unknown>>(identity.encryptionKey, encrypted.nonce, encrypted.ciphertext);
    result.push(...reader.read(decoded)); count++;
  }
  expect(count).toBeGreaterThan(1); expect(result).toEqual([request]);
});

it("keeps small requests in one ordinary frame", () => {
  const request = { id: "health", method: "daemon.health" };
  expect([...remoteUploadFrames(request)]).toEqual([request]);
});
