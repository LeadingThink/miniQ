import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import qiniu from "qiniu";

export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const TICKET_SECONDS = 300;

export interface BlobTicket { putUrl: string; getUrl: string; expiresAt: number }
export interface TicketIssuer {
  enabledFor(roomId: string): boolean;
  ticket(roomId: string, bytes: number): Promise<BlobTicket>;
}

export class BlobStore implements TicketIssuer {
  private readonly client: S3Client;
  private readonly verified: Promise<void>;
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
    this.verified = manager.getBucketInfo(config.bucket).then(({ data, resp }) => {
      if (resp.statusCode !== 200 || data.private !== 1) throw new Error("Remote object storage requires a private bucket");
      if (!data.bucket_rules?.some((rule: { prefix: string; delete_after_days: number }) => rule.prefix === "remote/" && rule.delete_after_days === 1)) throw new Error("Remote object storage requires a one-day expiration rule");
    });
    // Tickets remain disabled on verification failure; never expose SDK errors containing URLs.
    void this.verified.catch(() => console.error("Private object storage verification failed"));
  }

  enabledFor(roomId: string): boolean { return this.rooms.has(roomId); }

  async ticket(roomId: string, bytes: number): Promise<BlobTicket> {
    if (!this.enabledFor(roomId) || !Number.isSafeInteger(bytes) || bytes < 16 || bytes > MAX_BLOB_BYTES) throw new Error("Invalid object request");
    await this.verified;
    const key = `remote/${roomId}/${randomUUID()}`;
    const options = { expiresIn: TICKET_SECONDS };
    const putUrl = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentLength: bytes, ContentType: "application/octet-stream" }), options);
    const getUrl = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), options);
    return { putUrl, getUrl, expiresAt: Date.now() + TICKET_SECONDS * 1000 };
  }
}

export function configuredBlobStore(): BlobStore | undefined {
  const env = process.env;
  if (!env.MINIQ_BLOB_BUCKET) return;
  const names = ["ACCESS_KEY", "SECRET_KEY", "BUCKET", "ENDPOINT", "REGION", "ALLOWED_ROOMS"];
  if (names.some((name) => !env[`MINIQ_BLOB_${name}`])) throw new Error("Incomplete private object storage configuration");
  return new BlobStore({ accessKey: env.MINIQ_BLOB_ACCESS_KEY!, secretKey: env.MINIQ_BLOB_SECRET_KEY!, bucket: env.MINIQ_BLOB_BUCKET!, endpoint: env.MINIQ_BLOB_ENDPOINT!, region: env.MINIQ_BLOB_REGION!, rooms: env.MINIQ_BLOB_ALLOWED_ROOMS!.split(",").map((room) => room.trim()).filter(Boolean) });
}
