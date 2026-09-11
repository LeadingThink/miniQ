import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES, parseShare, publicMeta, SHARE_ID, ShareError, ShareStore, shareOwner } from "./shareStore.js";

export type ShareAuth = (key: string) => Promise<boolean>;

export function oneApiShareAuth(): ShareAuth {
  const verified = new Map<string, number>();
  return async (key) => {
    const owner = shareOwner(key);
    if ((verified.get(owner) ?? 0) > Date.now()) return true;
    const response = await fetch("https://oneapi.zaiwenai.com/v1/auth/key", {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (response.status !== 200) { await response.body?.cancel(); return false; }
    // /v1/models is intentionally public and cannot authenticate a share author.
    const identity = await response.json() as { valid?: unknown };
    if (identity?.valid !== true) return false;
    for (const [id, expiry] of verified) if (expiry <= Date.now()) verified.delete(id);
    if (verified.size >= 500) verified.delete(verified.keys().next().value!);
    verified.set(owner, Date.now() + 60000);
    return true;
  };
}

export class ShareHttp {
  private readonly rate = new Map<string, { until: number; count: number }>();
  constructor(readonly store: ShareStore, private readonly authenticate: ShareAuth) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    response.setHeader("Referrer-Policy", "no-referrer");
    try { await this.route(request, response); }
    catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof ShareError ? error.status : 503;
      sendJson(response, status, { error: error instanceof ShareError ? error.message : "分享服务暂时不可用，请稍后重试" });
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url!, "http://relay.local");
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[1];
    if (request.method === "GET" && id && id !== "manage") {
      if (parts.length === 2) {
        const page = url.searchParams.get("page") ?? "0";
        if (!/^\d+$/.test(page)) throw new ShareError(400, "分页位置无效");
        return sendJson(response, 200, await this.store.page(id, Number(page)));
      }
      if (parts.length === 4 && parts[2] === "files") return this.download(id, parts[3], request, response);
      throw new ShareError(404, "分享不存在或已失效");
    }
    const key = request.headers.authorization?.match(/^Bearer (\S{8,512})$/)?.[1];
    if (!key) throw new ShareError(401, "请配置有效的 OneAPI Key 后分享");
    const owner = shareOwner(key);
    this.consume(owner);
    if (!await this.authenticate(key)) throw new ShareError(401, "OneAPI Key 无效或已停用");
    if (request.method === "GET" && id === "manage") {
      const scope = url.searchParams.get("scope") ?? "";
      const after = url.searchParams.get("after") ?? "";
      if (!/^[a-f0-9]{64}$/.test(scope) || (after && !SHARE_ID.test(after))) throw new ShareError(400, "分享查询无效");
      return sendJson(response, 200, await this.store.list(owner, scope, after));
    }
    if (!id || !SHARE_ID.test(id)) throw new ShareError(404, "分享不存在或已失效");
    await this.store.exclusive(id, async () => {
      if (request.method === "PUT" && parts.length === 2) {
        const body = await readJson(request);
        return sendJson(response, 200, publicMeta(await this.store.create(id, owner, parseShare(body))));
      }
      if (request.method === "PUT" && parts.length === 4 && parts[2] === "files") {
        await this.upload(id, parts[3], owner, request);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "POST" && parts.length === 3 && parts[2] === "publish")
        return sendJson(response, 200, publicMeta(await this.store.publish(id, owner)));
      if (request.method === "DELETE" && parts.length === 2) {
        const meta = await this.store.meta(id, owner);
        if (request.headers["x-share-scope"] !== meta.scope) throw new ShareError(404, "分享不属于此会话");
        await this.store.remove(id, owner);
        return sendJson(response, 200, { ok: true });
      }
      throw new ShareError(405, "分享操作不支持");
    });
  }

  private consume(owner: string) {
    const now = Date.now();
    for (const [key, value] of this.rate) if (value.until <= now) this.rate.delete(key);
    if (!this.rate.has(owner)) {
      if (this.rate.size >= 2000) throw new ShareError(429, "分享请求过多，请稍后重试");
      this.rate.set(owner, { until: now + 60000, count: 0 });
    }
    if (++this.rate.get(owner)!.count > 120) throw new ShareError(429, "分享请求过多，请稍后重试");
  }

  private async upload(id: string, fileId: string, owner: string, request: IncomingMessage) {
    const meta = await this.store.meta(id, owner);
    const file = meta.files.find((file) => file.id === fileId);
    if (!file) throw new ShareError(404, "文件不在此分享中");
    if (meta.published) throw new ShareError(409, "已发布的分享快照不能修改");
    if (Number(request.headers["content-length"]) !== file.size) throw new ShareError(400, "文件大小不匹配");
    const path = this.store.path(id, `${fileId}.part`);
    let bytes = 0;
    const hash = createHash("sha256");
    const check = new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > file.size || bytes > MAX_FILE_BYTES) { done(new ShareError(413, "文件超过声明大小")); return; }
      hash.update(chunk); done(null, chunk);
    } });
    try {
      await pipeline(request, check, createWriteStream(path, { mode: 0o600 }));
      if (bytes !== file.size || hash.digest("hex") !== file.sha256) throw new ShareError(409, "文件在上传期间发生变化，请重新生成分享");
      await rename(path, this.store.path(id, fileId));
    } finally { await rm(path, { force: true }); }
  }

  private async download(id: string, fileId: string, request: IncomingMessage, response: ServerResponse) {
    const meta = await this.store.meta(id);
    const file = meta.files.find((file) => file.id === fileId);
    if (!file) throw new ShareError(404, "文件不存在或未分享");
    const range = byteRange(request.headers.range, file.size);
    const type = publicFileType(file.name);
    response.setHeader("Content-Type", type);
    response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Disposition", `${type === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    if (range === false) {
      response.writeHead(416, { "Content-Range": `bytes */${file.size}` }).end(); return;
    }
    const [start, end] = range ?? [0, file.size - 1];
    response.setHeader("Content-Length", Math.max(0, end - start + 1));
    if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${file.size}`);
    response.writeHead(range ? 206 : 200);
    if (file.size === 0) { response.end(); return; }
    await pipeline(createReadStream(this.store.path(id, fileId), { start, end }), response);
  }
}

function byteRange(value: string | undefined, size: number): [number, number] | null | false {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? [start, end] : false;
}

function publicFileType(name: string): string {
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", pdf: "application/pdf" };
  return types[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_SNAPSHOT_BYTES) throw new ShareError(413, "正文超过 16 MB，请选择部分消息分享");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ShareError(400, "分享 JSON 无效"); }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
