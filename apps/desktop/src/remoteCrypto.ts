const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RemoteIdentity {
  roomId: string;
  authToken: string;
  encryptionKey: CryptoKey;
}

export async function deriveRemoteIdentity(apiKey: string): Promise<RemoteIdentity> {
  if (!apiKey.trim()) throw new Error("API Key 不能为空");
  const [room, auth, encryption] = await Promise.all([
    derive(apiKey, "miniq-relay-room-v1"),
    derive(apiKey, "miniq-relay-auth-v1"),
    derive(apiKey, "miniq-relay-encryption-v1"),
  ]);
  return {
    roomId: toBase64Url(room),
    authToken: toBase64Url(auth),
    encryptionKey: await crypto.subtle.importKey("raw", encryption, "AES-GCM", false, ["encrypt", "decrypt"]),
  };
}

export async function encryptRemotePayload(key: CryptoKey, value: unknown) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce) },
    key,
    asArrayBuffer(plaintext),
  );
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

export async function decryptRemotePayload<T>(
  key: CryptoKey,
  nonceValue: string,
  ciphertextValue: string,
): Promise<T> {
  const nonce = fromBase64Url(nonceValue);
  if (nonce.byteLength !== 12) throw new Error("远程消息 nonce 无效");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce) },
    key,
    asArrayBuffer(fromBase64Url(ciphertextValue)),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

async function derive(apiKey: string, label: string): Promise<ArrayBuffer> {
  const labelBytes = encoder.encode(label);
  const keyBytes = encoder.encode(apiKey);
  const input = new Uint8Array(labelBytes.length + 1 + keyBytes.length);
  input.set(labelBytes);
  input[labelBytes.length] = 0;
  input.set(keyBytes, labelBytes.length + 1);
  return crypto.subtle.digest("SHA-256", asArrayBuffer(input));
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
