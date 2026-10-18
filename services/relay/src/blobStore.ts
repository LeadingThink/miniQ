import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import qiniu from "qiniu";

export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const MAX_PROVIDER_MEDIA_BYTES = 256 * 1024 * 1024;
export const MAX_REMOTE_FILE_BYTES = 200 * 1024 * 1024;
const TICKET_SECONDS = 300;
const PROVIDER_MEDIA_TICKET_SECONDS = 900;
const ROOM_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_MEDIA_CONTENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp",
  "video/mp4", "video/webm", "video/mov", "video/quicktime",
  "audio/mpeg", "audio/wav", "audio/mp3", "audio/m4a", "audio/mp4", "audio/aac", "audio/ogg", "audio/flac",
]);

export function isProviderMediaContentType(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_MEDIA_CONTENT_TYPES.has(value);
}

export function isRemoteFileSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

export interface BlobTicket { putUrl: string; getUrl: string; expiresAt: number; objectId?: string }
export interface TicketIssuer {
  enabledFor(roomId: string): boolean;
  ticket(roomId: string, bytes: number, desktopDeviceId?: string): Promise<BlobTicket>;
  providerMediaEnabledFor?(roomId: string): boolean;
  /** File storage has its own rollout gate; provider-media room allowlists must not gate it. */
  fileStorageEnabledFor?(roomId: string): boolean;
  providerMediaTicket?(roomId: string, bytes: number, contentType: string, desktopDeviceId: string): Promise<BlobTicket>;
  authenticatedMediaTicket?(owner: string, bytes: number, contentType: string): Promise<BlobTicket>;
  remoteFileTicket?(roomId: string, bytes: number, desktopDeviceId: string, sessionId: string, objectId?: string): Promise<BlobTicket>;
}

export class BlobStore implements TicketIssuer {
  private readonly client: S3Client;
  private readonly remoteVerified: Promise<void>;
  private readonly providerVerified: Promise<void>;
  private readonly filesVerified: Promise<void>;
  private providerReady = false;
  private readonly rooms: Set<string>;
  private readonly bucket: string;

  constructor(config: { accessKey: string; secretKey: string; bucket: string; endpoint: string; region: string; rooms: string[] }) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".qiniucs.com")) throw new Error("Expected a secure Qiniu S3 endpoint");
    this.rooms = new Set(config.rooms);
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: endpoint.href, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
    const manager = new qiniu.rs.BucketManager(new qiniu.auth.digest.Mac(config.accessKey, config.secretKey), new qiniu.conf.Config({ useHttpsDomain: true }));
    const privateVerified = manager.getBucketInfo(config.bucket).then(({ data, resp }) => {
      if (resp.statusCode !== 200 || data.private !== 1) throw new Error("Remote object storage requires a private bucket");
      return data;
    });
    const verifyLifecycle = (prefix: string) => privateVerified.then((data) => {
      if (!data.bucket_rules?.some((rule: { prefix: string; delete_after_days: number }) => rule.prefix === prefix && rule.delete_after_days === 1)) throw new Error(`Object storage requires a one-day expiration rule for ${prefix}`);
    });
    this.remoteVerified = verifyLifecycle("remote/");
    this.providerVerified = verifyLifecycle("provider-media/").then(() => { this.providerReady = true; });
    this.filesVerified = verifyLifecycle("remote-files/");
    // Tickets remain disabled on verification failure; never expose SDK errors containing URLs.
    void Promise.allSettled([this.remoteVerified, this.providerVerified, this.filesVerified]).then((results) => {
      if (results.some((result) => result.status === "rejected")) console.error("Private object storage verification failed");
    });
  }

  enabledFor(roomId: string): boolean { return this.rooms.has(roomId); }

  providerMediaEnabledFor(roomId: string): boolean {
    return this.providerReady && typeof roomId === "string" && ROOM_PATTERN.test(roomId) && this.enabledFor(roomId);
  }

  fileStorageEnabledFor(roomId: string): boolean {
    // Verification is awaited by remoteFileTicket; this synchronous capability
    // predicate only answers whether the rollout applies to this authenticated
    // room, without inheriting the provider-media allowlist.
    return typeof roomId === "string" && ROOM_PATTERN.test(roomId);
  }

  async ticket(roomId: string, bytes: number, desktopDeviceId?: string): Promise<BlobTicket> {
    if (!this.enabledFor(roomId) || !Number.isSafeInteger(bytes) || bytes < 16 || bytes > MAX_BLOB_BYTES) throw new Error("Invalid object request");
    await this.remoteVerified;
    if (desktopDeviceId !== undefined && !/^[A-Za-z0-9_-]{8,80}$/.test(desktopDeviceId)) throw new Error("Invalid desktop device");
    const key = `remote/${roomId}/${desktopDeviceId ? `${desktopDeviceId}/` : ""}${randomUUID()}`;
    const options = { expiresIn: TICKET_SECONDS };
    const putUrl = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentLength: bytes, ContentType: "application/octet-stream" }), options);
    const getUrl = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), options);
    return { putUrl, getUrl, expiresAt: Date.now() + TICKET_SECONDS * 1000 };
  }

  async providerMediaTicket(roomId: string, bytes: number, contentType: string, desktopDeviceId: string): Promise<BlobTicket> {
    if (typeof roomId !== "string" || !ROOM_PATTERN.test(roomId) || !this.enabledFor(roomId)
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_PROVIDER_MEDIA_BYTES
      || !isProviderMediaContentType(contentType)) throw new Error("Invalid provider media request");
    if (typeof desktopDeviceId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(desktopDeviceId)) throw new Error("Invalid desktop device");
    return this.signProviderMedia(`provider-media/${roomId}/${desktopDeviceId}/${randomUUID()}`, bytes, contentType);
  }

  /** Session authorization belongs to the daemon; the relay isolates its object keys. */
  async remoteFileTicket(roomId: string, bytes: number, desktopDeviceId: string, sessionId: string, objectId?: string): Promise<BlobTicket> {
    if (typeof roomId !== "string" || !this.fileStorageEnabledFor(roomId)
      || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_REMOTE_FILE_BYTES
      || typeof desktopDeviceId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(desktopDeviceId)
      || !isRemoteFileSessionId(sessionId)
      || (objectId !== undefined && !/^[0-9a-f-]{36}$/i.test(objectId))) throw new Error("Invalid remote file request");
    await this.filesVerified;
    const sessionHash = createHash("sha256").update(sessionId).digest("hex");
    const id = objectId ?? randomUUID();
    return this.signObject(`remote-files/${roomId}/${desktopDeviceId}/${sessionHash}/${id}`, bytes, "application/octet-stream", id);
  }

  /** Called only after the HTTP handler validates the account key. */
  async authenticatedMediaTicket(owner: string, bytes: number, contentType: string): Promise<BlobTicket> {
    if (!/^[a-f0-9]{64}$/.test(owner) || !Number.isSafeInteger(bytes) || bytes < 1
      || bytes > MAX_PROVIDER_MEDIA_BYTES || !isProviderMediaContentType(contentType)) throw new Error("Invalid provider media request");
    return this.signProviderMedia(`provider-media/accounts/${owner}/${randomUUID()}`, bytes, contentType);
  }

  private async signProviderMedia(key: string, bytes: number, contentType: string): Promise<BlobTicket> {
    await this.providerVerified;
    return this.signObject(key, bytes, contentType);
  }

  private async signObject(key: string, bytes: number, contentType: string, objectId?: string): Promise<BlobTicket> {
    const options = { expiresIn: PROVIDER_MEDIA_TICKET_SECONDS };
    const putUrl = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentLength: bytes, ContentType: contentType }), {
      ...options, signableHeaders: new Set(["content-type", "content-length"]),
    });
    const getUrl = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), options);
    return { putUrl, getUrl, expiresAt: Date.now() + PROVIDER_MEDIA_TICKET_SECONDS * 1000, ...(objectId ? { objectId } : {}) };
  }
}

export function configuredBlobStore(): BlobStore | undefined {
  const env = process.env;
  if (!env.MINIQ_BLOB_BUCKET) return;
  const names = ["ACCESS_KEY", "SECRET_KEY", "BUCKET", "ENDPOINT", "REGION", "ALLOWED_ROOMS"];
  if (names.some((name) => !env[`MINIQ_BLOB_${name}`])) throw new Error("Incomplete private object storage configuration");
  return new BlobStore({ accessKey: env.MINIQ_BLOB_ACCESS_KEY!, secretKey: env.MINIQ_BLOB_SECRET_KEY!, bucket: env.MINIQ_BLOB_BUCKET!, endpoint: env.MINIQ_BLOB_ENDPOINT!, region: env.MINIQ_BLOB_REGION!, rooms: env.MINIQ_BLOB_ALLOWED_ROOMS!.split(",").map((room) => room.trim()).filter(Boolean) });
}
