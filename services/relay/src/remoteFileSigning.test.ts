import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BlobStore, MAX_REMOTE_FILE_BYTES } from "./blobStore.js";

const { getBucketInfo } = vi.hoisted(() => ({ getBucketInfo: vi.fn() }));
vi.mock("qiniu", () => ({ default: {
  rs: { BucketManager: class { getBucketInfo = getBucketInfo; } },
  auth: { digest: { Mac: class {} } }, conf: { Config: class {} },
} }));
const room = "r".repeat(43);
const config = { accessKey: "test-access", secretKey: "test-secret", bucket: "private-files",
  endpoint: "https://s3-cn-east-1.qiniucs.com", region: "cn-east-1", rooms: [room] };
const rules = ["remote/", "provider-media/", "remote-files/"].map((prefix) => ({ prefix, delete_after_days: 1 }));
beforeEach(() => {
  getBucketInfo.mockResolvedValue({ data: { private: 1, bucket_rules: rules }, resp: { statusCode: 200 } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
it("signs files for authenticated rooms outside the provider-media rollout list", async () => {
  const store = new BlobStore({ ...config, rooms: [] });
  const ticket = await store.remoteFileTicket(room, 0, "desktop-aaaa", "session");
  expect(ticket.putUrl).toContain("remote-files");
  expect(store.enabledFor(room)).toBe(false);
  expect(store.fileStorageEnabledFor(room)).toBe(true);
});it.each([0, MAX_REMOTE_FILE_BYTES])("signs real SDK URLs with exact headers, scoped hash, TTL and unique keys for %s bytes", async (bytes) => {
  const store = new BlobStore(config);
  const start = Date.now();
  const ticket = await store.remoteFileTicket(room, bytes, "desktop-aaaa", "private/session");
  const put = new URL(ticket.putUrl), get = new URL(ticket.getUrl);
  const hash = createHash("sha256").update("private/session").digest("hex");
  expect(put.pathname).toMatch(new RegExp(`^/private-files/remote-files/${room}/desktop-aaaa/${hash}/[a-f0-9-]{36}$`));
  expect(put.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  expect(put.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(get.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(get.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(get.pathname).toBe(put.pathname);
  expect(ticket.expiresAt).toBeGreaterThanOrEqual(start + 900000);
  expect(ticket.expiresAt).toBeLessThanOrEqual(Date.now() + 900000);
  expect(Object.keys(ticket).sort()).toEqual(["expiresAt", "getUrl", "objectId", "putUrl"]);
  expect(JSON.stringify(ticket)).not.toContain("private/session");
  expect(JSON.stringify(ticket)).not.toContain("test-secret");
  const next = await store.remoteFileTicket(room, bytes, "desktop-aaaa", "private/session");
  expect(new URL(next.putUrl).pathname).not.toBe(put.pathname);
});
it.each([
  { privacy: 0, statusCode: 200, rules }, { privacy: 1, statusCode: 403, rules },
  ...[[], rules.slice(0, 2), [{ prefix: "remote-files", delete_after_days: 1 }],
    [{ prefix: "remote-files/", delete_after_days: 2 }], [{ prefix: "", delete_after_days: 1 }]]
    .map((rules) => ({ privacy: 1, statusCode: 200, rules })),
])("blocks files when privacy or exact one-day lifecycle cannot be verified %j", async ({ privacy, statusCode, rules }) => {
  getBucketInfo.mockResolvedValue({ data: { private: privacy, bucket_rules: rules }, resp: { statusCode } });
  await expect(new BlobStore(config).remoteFileTicket(room, 0, "desktop-aaaa", "session")).rejects.toThrow();
});
it("isolates file lifecycle failures from existing media and RPC namespaces", async () => {
  getBucketInfo.mockResolvedValue({ data: { private: 1, bucket_rules: rules.slice(0, 2) }, resp: { statusCode: 200 } });
  const store = new BlobStore(config);
  await expect(store.remoteFileTicket(room, 1, "desktop-aaaa", "session")).rejects.toThrow("remote-files/");
  await expect(store.ticket(room, 16, "desktop-aaaa")).resolves.toHaveProperty("putUrl");
  await expect(store.providerMediaTicket(room, 1, "image/png", "desktop-aaaa")).resolves.toHaveProperty("putUrl");
});
it.each([
  [room, -1, "desktop-aaaa", "session"], [room, MAX_REMOTE_FILE_BYTES + 1, "desktop-aaaa", "session"],
  [room, 0.5, "desktop-aaaa", "session"], [room, 0, "../desktop", "session"],
  ["s".repeat(42), 0, "desktop-aaaa", "session"], [room, 0, "desktop-aaaa", ""],
  [room, 0, "desktop-aaaa", "s".repeat(257)], [room, 0, "desktop-aaaa", "a\nb"],
])("validates issuer inputs %j", async (roomId, bytes, device, session) => {
  await expect(new BlobStore(config).remoteFileTicket(roomId as string, bytes as number, device as string, session as string)).rejects.toThrow("Invalid remote file request");
});
