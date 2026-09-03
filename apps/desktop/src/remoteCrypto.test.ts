import { describe, expect, it } from "vitest";
import { decryptRemotePayload, deriveRemoteIdentity, encryptRemotePayload } from "./remoteCrypto";

describe("remote crypto", () => {
  it("derives stable domain-separated credentials", async () => {
    const first = await deriveRemoteIdentity("sk-test-secret");
    const second = await deriveRemoteIdentity("sk-test-secret");
    expect(first.roomId).toBe(second.roomId);
    expect(first.authToken).toBe(second.authToken);
    expect(first.roomId).toBe("DaSzo9SjSPu86bt0mw7BjsYK8-RWaBj0AklFHV50oeU");
    expect(first.authToken).toBe("Ql6-zLsUyp3DLtq-8OirdLEASP3fv70UACoYX-bxcvk");
    expect(first.roomId).not.toBe(first.authToken);
    expect(first.roomId).not.toContain("sk-test-secret");
  });

  it("round-trips JSON and rejects another key", async () => {
    const identity = await deriveRemoteIdentity("sk-test-secret");
    const encrypted = await encryptRemotePayload(identity.encryptionKey, { method: "daemon.health" });
    await expect(decryptRemotePayload(identity.encryptionKey, encrypted.nonce, encrypted.ciphertext))
      .resolves.toEqual({ method: "daemon.health" });
    const other = await deriveRemoteIdentity("sk-other-secret");
    await expect(decryptRemotePayload(other.encryptionKey, encrypted.nonce, encrypted.ciphertext)).rejects.toThrow();
  });
});
