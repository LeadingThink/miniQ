import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobStore, MAX_BLOB_BYTES, MAX_PROVIDER_MEDIA_BYTES, isProviderMediaContentType, type TicketIssuer } from "./blobStore.js";

const { getBucketInfo } = vi.hoisted(() => ({ getBucketInfo: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...await importOriginal<typeof import("@aws-sdk/client-s3")>(),
  S3Client: vi.fn(function () {}),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));
vi.mock("qiniu", () => ({ default: {
  rs: { BucketManager: vi.fn(function () { return { getBucketInfo }; }) },
  auth: { digest: { Mac: vi.fn(function () {}) } },
  conf: { Config: vi.fn(function () {}) },
} }));

const roomId = "r".repeat(43);
const deviceId = "desktop-aaaa";
const config = {
  accessKey: "access", secretKey: "secret", bucket: "private-media",
  endpoint: "https://s3-cn-east-1.qiniucs.com", region: "cn-east-1", rooms: [roomId],
};
const rules = [
  { prefix: "remote/", delete_after_days: 1 },
  { prefix: "provider-media/", delete_after_days: 1 },
];
const contentTypes = [
  "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm", "video/mov",
  "audio/mpeg", "audio/wav", "audio/mp3", "audio/m4a", "audio/aac", "audio/ogg",
];
const now = 1_750_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  getBucketInfo.mockResolvedValue({ data: { private: 1, bucket_rules: rules }, resp: { statusCode: 200 } });
  vi.mocked(getSignedUrl).mockImplementation(async (_client, command) => command instanceof PutObjectCommand ? "signed-put" : "signed-get");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("provider media tickets", () => {
  it("signs PUT and GET for a unique room/device key with a 15-minute expiry", async () => {
    const store = new BlobStore(config);
    expect(MAX_PROVIDER_MEDIA_BYTES).toBe(268_435_456);
    const ticket = await store.providerMediaTicket(roomId, 4096, "video/mp4", deviceId);
    expect(ticket).toEqual({ putUrl: "signed-put", getUrl: "signed-get", expiresAt: now + 900_000 });
    expect(getBucketInfo).toHaveBeenCalledWith(config.bucket);
    expect(S3Client).toHaveBeenCalledWith(expect.objectContaining({ endpoint: `${config.endpoint}/`, forcePathStyle: true }));
    const [put, get] = vi.mocked(getSignedUrl).mock.calls;
    expect(put[1]).toBeInstanceOf(PutObjectCommand);
    expect(put[1].input).toEqual({
      Bucket: config.bucket,
      Key: expect.stringMatching(new RegExp(`^provider-media/${roomId}/${deviceId}/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)),
      ContentLength: 4096, ContentType: "video/mp4",
    });
    expect(get[1]).toBeInstanceOf(GetObjectCommand);
    expect(get[1].input).toEqual({ Bucket: config.bucket, Key: (put[1] as PutObjectCommand).input.Key });
    expect(put[0]).toBe(get[0]);
    expect(put[2]).toEqual({ expiresIn: 900, signableHeaders: new Set(["content-type", "content-length"]) });
    expect(get[2]).toEqual({ expiresIn: 900 });
    await store.providerMediaTicket(roomId, 4096, "video/mp4", deviceId);
    expect((vi.mocked(getSignedUrl).mock.calls[2][1] as PutObjectCommand).input.Key).not.toBe((put[1] as PutObjectCommand).input.Key);
  });

  it("binds provider PUT content type and length with the actual SDK presigner without network access", async () => {
    const { S3Client: RealS3Client } = await vi.importActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3");
    const { getSignedUrl: realGetSignedUrl } = await vi.importActual<typeof import("@aws-sdk/s3-request-presigner")>("@aws-sdk/s3-request-presigner");
    const handle = vi.fn(async () => { throw new Error("Signing must not send a network request"); });
    const client = new RealS3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { handle },
    });
    try {
      await new BlobStore(config).providerMediaTicket(roomId, 4096, "video/mp4", deviceId);
      const [put, get] = vi.mocked(getSignedUrl).mock.calls;
      const putUrl = new URL(await realGetSignedUrl(client, put[1], put[2]));
      const getUrl = new URL(await realGetSignedUrl(client, get[1], get[2]));
      expect(putUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(["content-length", "content-type", "host"]);
      expect(getUrl.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(putUrl.searchParams.get("X-Amz-Expires")).toBe("900");
      expect(getUrl.searchParams.get("X-Amz-Expires")).toBe("900");
      const input = (put[1] as PutObjectCommand).input;
      for (const change of [{ ContentType: "video/webm" }, { ContentLength: 4097 }]) {
        const changedUrl = new URL(await realGetSignedUrl(client, new PutObjectCommand({ ...input, ...change }), put[2]));
        expect(changedUrl.searchParams.get("X-Amz-Signature")).not.toBe(putUrl.searchParams.get("X-Amz-Signature"));
      }
      expect(handle).not.toHaveBeenCalled();
    } finally { client.destroy(); }
  });

  it.each(contentTypes)("accepts and signs the exact MIME type %s", async (contentType) => {
    expect(isProviderMediaContentType(contentType)).toBe(true);
    await new BlobStore(config).providerMediaTicket(roomId, 1, contentType, deviceId);
    expect(vi.mocked(getSignedUrl).mock.calls[0][1].input).toMatchObject({ ContentLength: 1, ContentType: contentType });
  });

  it.each([1, MAX_PROVIDER_MEDIA_BYTES])("accepts the size boundary %s", async (bytes) => {
    await new BlobStore(config).providerMediaTicket(roomId, bytes, "image/png", deviceId);
    expect(vi.mocked(getSignedUrl).mock.calls[0][1].input).toMatchObject({ ContentLength: bytes });
  });

  it.each([0, -1, 1.5, MAX_PROVIDER_MEDIA_BYTES + 1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null, undefined])("rejects invalid size %s before signing", async (bytes) => {
    await expect(new BlobStore(config).providerMediaTicket(roomId, bytes as number, "image/png", deviceId)).rejects.toThrow("Invalid provider media request");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it.each(["application/octet-stream", "image/svg+xml", "text/html", "image/jpg", "audio/x-wav", "image/PNG", " image/png", "image/png ", "image/png; charset=utf-8", "", null, undefined, 1])("rejects non-whitelisted MIME type %s", async (contentType) => {
    expect(isProviderMediaContentType(contentType)).toBe(false);
    await expect(new BlobStore(config).providerMediaTicket(roomId, 1, contentType as string, deviceId)).rejects.toThrow("Invalid provider media request");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects a valid room that is not enabled", async () => {
    const store = new BlobStore(config);
    expect(store.enabledFor(roomId)).toBe(true);
    expect(store.enabledFor("s".repeat(43))).toBe(false);
    await expect(store.providerMediaTicket("s".repeat(43), 1, "image/png", deviceId)).rejects.toThrow("Invalid provider media request");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it.each(["", "../room", "r".repeat(42), "r".repeat(44), `${"r".repeat(42)}/`, null, undefined])("rejects malformed room %s even if configured", async (room) => {
    const store = new BlobStore({ ...config, rooms: [room as string] });
    await expect(store.providerMediaTicket(room as string, 1, "image/png", deviceId)).rejects.toThrow("Invalid provider media request");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it.each(["", "short", "a".repeat(81), "../desktop", "desktop/a", "desktop a", null, undefined])("requires a valid desktop device %s", async (device) => {
    await expect(new BlobStore(config).providerMediaTicket(roomId, 1, "image/png", device as string)).rejects.toThrow("Invalid desktop device");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it.each(["a_-12345", "d".repeat(80)])("accepts the device boundary %s", async (device) => {
    await new BlobStore(config).providerMediaTicket(roomId, 1, "image/png", device);
    expect((vi.mocked(getSignedUrl).mock.calls[0][1] as PutObjectCommand).input.Key).toMatch(new RegExp(`^provider-media/${roomId}/${device}/`));
  });

  it("waits for startup verification before signing", async () => {
    let resolve!: (value: unknown) => void;
    getBucketInfo.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = new BlobStore(config).providerMediaTicket(roomId, 1, "image/png", deviceId);
    await Promise.resolve();
    expect(getSignedUrl).not.toHaveBeenCalled();
    resolve({ data: { private: 1, bucket_rules: rules }, resp: { statusCode: 200 } });
    await expect(pending).resolves.toMatchObject({ putUrl: "signed-put" });
  });
});

describe("private bucket and lifecycle verification", () => {
  it.each([
    { private: 0, statusCode: 200 },
    { private: undefined, statusCode: 200 },
    { private: 1, statusCode: 403 },
  ])("blocks both ticket kinds when the bucket is not verified private: %j", async ({ private: privacy, statusCode }) => {
    getBucketInfo.mockResolvedValue({ data: { private: privacy, bucket_rules: rules }, resp: { statusCode } });
    const store = new BlobStore(config);
    await expect(store.ticket(roomId, 16)).rejects.toThrow("requires a private bucket");
    await expect(store.providerMediaTicket(roomId, 1, "image/png", deviceId)).rejects.toThrow("requires a private bucket");
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("Private object storage verification failed");
  });

  it.each([
    { bucket_rules: undefined, missing: "remote/" },
    { bucket_rules: [], missing: "remote/" },
    { bucket_rules: [rules[0]], missing: "provider-media/" },
    { bucket_rules: [rules[1]], missing: "remote/" },
    { bucket_rules: [rules[0], { prefix: "provider-media/", delete_after_days: 2 }], missing: "provider-media/" },
    { bucket_rules: [{ prefix: "remote/", delete_after_days: 2 }, rules[1]], missing: "remote/" },
    { bucket_rules: [rules[0], { prefix: "provider-media", delete_after_days: 1 }], missing: "provider-media/" },
    { bucket_rules: [rules[0], { prefix: "provider-media/room/", delete_after_days: 1 }], missing: "provider-media/" },
    { bucket_rules: [{ prefix: "", delete_after_days: 1 }], missing: "remote/" },
  ])("requires an exact one-day rule for $missing", async ({ bucket_rules, missing }) => {
    getBucketInfo.mockResolvedValue({ data: { private: 1, bucket_rules }, resp: { statusCode: 200 } });
    const store = new BlobStore(config);
    const message = `one-day expiration rule for ${missing}`;
    if (missing === "remote/") {
      await expect(store.ticket(roomId, 16)).rejects.toThrow(message);
    } else {
      await expect(store.providerMediaTicket(roomId, 1, "image/png", deviceId)).rejects.toThrow(message);
    }
    // Each purpose verifies its own lifecycle; adding media cannot disable RPC blobs.
  });

  it("keeps verification failures from signing and logs no SDK details", async () => {
    getBucketInfo.mockRejectedValue(new Error("SDK URL with secret"));
    const store = new BlobStore(config);
    await expect(store.providerMediaTicket(roomId, 1, "image/png", deviceId)).rejects.toThrow("SDK URL with secret");
    await expect(store.ticket(roomId, 16)).rejects.toThrow("SDK URL with secret");
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Private object storage verification failed");
  });
});

describe("existing encrypted blob tickets", () => {
  it.each([undefined, deviceId])("preserves remote keys, octet-stream and 300-second expiry (device %s)", async (device) => {
    expect(MAX_BLOB_BYTES).toBe(67_108_864);
    const ticket = await new BlobStore(config).ticket(roomId, 16, device);
    expect(ticket).toEqual({ putUrl: "signed-put", getUrl: "signed-get", expiresAt: now + 300_000 });
    const [put, get] = vi.mocked(getSignedUrl).mock.calls;
    expect(put[1]).toBeInstanceOf(PutObjectCommand);
    expect(put[1].input).toEqual({
      Bucket: config.bucket, Key: expect.stringMatching(new RegExp(`^remote/${roomId}/${device ? `${device}/` : ""}[a-f0-9-]{36}$`)),
      ContentLength: 16, ContentType: "application/octet-stream",
    });
    expect(get[1]).toBeInstanceOf(GetObjectCommand);
    expect(get[1].input).toEqual({ Bucket: config.bucket, Key: (put[1] as PutObjectCommand).input.Key });
    expect(put[2]).toEqual({ expiresIn: 300 });
    expect(get[2]).toEqual({ expiresIn: 300 });
  });

  it("preserves the 64 MiB limit", async () => {
    await new BlobStore(config).ticket(roomId, MAX_BLOB_BYTES);
    expect(vi.mocked(getSignedUrl).mock.calls[0][1].input).toMatchObject({ ContentLength: MAX_BLOB_BYTES });
  });

  it.each([0, 15, 16.5, MAX_BLOB_BYTES + 1, NaN, Infinity])("rejects an invalid encrypted blob size %s", async (bytes) => {
    await expect(new BlobStore(config).ticket(roomId, bytes)).rejects.toThrow("Invalid object request");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects disabled rooms and invalid optional desktop IDs", async () => {
    const store = new BlobStore(config);
    await expect(store.ticket("s".repeat(43), 16)).rejects.toThrow("Invalid object request");
    await expect(store.ticket(roomId, 16, "../desktop")).rejects.toThrow("Invalid desktop device");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("supports TicketIssuer implementations that only issue encrypted blobs", async () => {
    const issuer: TicketIssuer = {
      enabledFor: () => true,
      ticket: async () => ({ putUrl: "old-put", getUrl: "old-get", expiresAt: 1 }),
    };
    expect(issuer.providerMediaTicket).toBeUndefined();
    await expect(issuer.ticket(roomId, 16)).resolves.toMatchObject({ putUrl: "old-put" });
  });
});
