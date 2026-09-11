import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

export const SHARE_ID = /^[a-f0-9]{32}$/;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_SHARE_BYTES = 512 * 1024 * 1024;
export class ShareError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface ShareMessage { role: "user" | "assistant"; content: string; createdAt: string }
export interface ShareFile { id: string; name: string; size: number; sha256: string }
export interface ShareInput { scope: string; title: string; expiresInDays: number; messages: ShareMessage[]; files: ShareFile[] }
export interface ShareMeta {
  id: string; owner: string; scope: string; title: string; createdAt: string;
  expiresAt: string; published: boolean; messageCount: number; files: ShareFile[];
  fingerprint: string;
}

// Whitelist the public schema: tool payloads, model configuration and local paths
// must never be copied to a share merely because a caller added extra fields.
export function parseShare(raw: unknown): ShareInput {
  const value = raw as ShareInput | null;
  if (!value || typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope) || typeof value.title !== "string" ||
      !value.title.trim() || value.title.length > 300 || ![7, 30, 90].includes(value.expiresInDays) ||
      !Array.isArray(value.messages) || !value.messages.length || !Array.isArray(value.files) || value.files.length > 30)
    throw new ShareError(400, "分享内容无效");
  const messages = value.messages.map((message) => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" ||
        typeof message.createdAt !== "string" || !Number.isFinite(Date.parse(message.createdAt)))
      throw new ShareError(400, "分享消息无效");
    return { role: message.role, content: message.content, createdAt: message.createdAt };
  });
  const files = value.files.map((file) => {
    if (!file || typeof file.id !== "string" || !SHARE_ID.test(file.id) || typeof file.name !== "string" || !file.name ||
        file.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(file.name) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new ShareError(400, "分享文件无效（单文件上限 256 MB）");
    return { id: file.id, name: file.name, size: file.size, sha256: file.sha256 };
  });
  if (new Set(files.map((file) => file.id)).size !== files.length || files.reduce((sum, file) => sum + file.size, 0) > MAX_SHARE_BYTES)
    throw new ShareError(400, "分享文件重复或总大小超过 512 MB");
  return { scope: value.scope, title: value.title.trim(), expiresInDays: value.expiresInDays, messages, files };
}

export class ShareStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(readonly root: string) {}

  async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    this.locks.set(id, result);
    try { return await result; } finally { if (this.locks.get(id) === result) this.locks.delete(id); }
  }

  path(id: string, file: string): string {
    if (!SHARE_ID.test(id)) throw new ShareError(404, "分享不存在或已失效");
    return join(this.root, id, file);
  }

  async meta(id: string, owner?: string): Promise<ShareMeta> {
    let value: ShareMeta;
    try { value = JSON.parse(await readFile(this.path(id, "meta.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new ShareError(404, "分享不存在或已失效");
    }
    if (Date.parse(value.expiresAt) <= Date.now() || (owner ? value.owner !== owner : !value.published))
      throw new ShareError(404, "分享不存在或已失效");
    return value;
  }

  async create(id: string, owner: string, input: ShareInput): Promise<ShareMeta> {
    // Different share IDs still reserve the same owner's storage budget.
    return this.exclusive(`owner:${owner}`, () => this.createSnapshot(id, owner, input));
  }

  private async createSnapshot(id: string, owner: string, input: ShareInput): Promise<ShareMeta> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    try {
      const existing = await this.meta(id, owner);
      if (existing.fingerprint !== fingerprint) throw new ShareError(409, "分享内容已变化，请重新创建链接");
      return existing;
    } catch (error) {
      if (!(error instanceof ShareError) || error.status !== 404) throw error;
    }
    await this.quota(owner, input);
    const draft = join(this.root, `.draft-${randomBytes(16).toString("hex")}`);
    await mkdir(draft, { mode: 0o700 });
    const created = Date.now();
    const meta: ShareMeta = { id, owner, scope: input.scope, title: input.title,
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + input.expiresInDays * 86400000).toISOString(),
      published: false, messageCount: input.messages.length, files: input.files, fingerprint };
    try {
      for (let index = 0; index < input.messages.length; index += 50)
        await writeFile(join(draft, `page-${index / 50}.json`), JSON.stringify(input.messages.slice(index, index + 50)), { mode: 0o600 });
      await writeFile(join(draft, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
      await rename(draft, this.path(id, ""));
    } finally { await rm(draft, { recursive: true, force: true }); }
    return meta;
  }

  private async quota(owner: string, input: ShareInput) {
    let count = 0; let used = 0;
    for (const id of await readdir(this.root)) {
      if (!SHARE_ID.test(id)) continue;
      const meta: ShareMeta | null = await this.meta(id, owner).catch((error) => {
        if (error instanceof ShareError && error.status === 404) return null; throw error;
      });
      if (meta) { count++; used += meta.files.reduce((sum, file) => sum + file.size, 0); }
    }
    const incoming = input.files.reduce((sum, file) => sum + file.size, 0);
    const space = await statfs(this.root);
    if (count >= 100 || used + incoming > 2 * 1024 * 1024 * 1024)
      throw new ShareError(429, "分享空间已满，请撤销不再需要的链接后重试");
    if (space.bavail * space.bsize < incoming + 1024 * 1024 * 1024)
      throw new ShareError(503, "分享存储空间不足，请稍后重试");
  }

  async publish(id: string, owner: string): Promise<ShareMeta> {
    const meta = await this.meta(id, owner);
    for (const file of meta.files) {
      const size = await stat(this.path(id, file.id)).then((value) => value.size).catch(() => -1);
      if (size !== file.size) throw new ShareError(409, "文件尚未完整上传，请重试");
    }
    meta.published = true;
    await writeFile(this.path(id, "meta.tmp"), JSON.stringify(meta), { mode: 0o600 });
    await rename(this.path(id, "meta.tmp"), this.path(id, "meta.json"));
    return meta;
  }

  async page(id: string, page: number) {
    const meta = await this.meta(id);
    if (!Number.isSafeInteger(page) || page < 0 || page * 50 >= meta.messageCount) throw new ShareError(400, "分页位置无效");
    const messages: ShareMessage[] = JSON.parse(await readFile(this.path(id, `page-${page}.json`), "utf8"));
    return { ...publicMeta(meta), messages, nextPage: (page + 1) * 50 < meta.messageCount ? page + 1 : null };
  }

  async list(owner: string, scope: string, after: string) {
    const entries = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    const shares = [];
    for (const id of entries.sort()) {
      if (!SHARE_ID.test(id) || id <= after) continue;
      const meta = await this.meta(id, owner).catch((error) => { if (error instanceof ShareError && error.status === 404) return null; throw error; });
      if (meta?.scope === scope) shares.push(publicMeta(meta));
      if (shares.length === 51) break;
    }
    const more = shares.length > 50;
    if (more) shares.pop();
    return { shares, nextCursor: more ? shares.at(-1)!.id : null };
  }

  async remove(id: string, owner: string) {
    await this.meta(id, owner);
    // Hide before removing bytes so concurrent public requests cannot see a partial snapshot.
    const tombstone = join(this.root, `.deleted-${id}`);
    await rename(this.path(id, ""), tombstone);
    await rm(tombstone, { recursive: true, force: true });
  }

  async cleanup() {
    const entries = await readdir(this.root).catch(() => []);
    let failed = false;
    for (const id of entries) {
      try {
        if (/^\.(draft|deleted)-[a-f0-9]{32}$/.test(id)) {
          const path = join(this.root, id);
          if ((await stat(path)).mtimeMs < Date.now() - 86400000)
            await rm(path, { recursive: true, force: true });
        } else if (SHARE_ID.test(id)) {
          await this.exclusive(id, async () => {
            const meta: ShareMeta = JSON.parse(await readFile(this.path(id, "meta.json"), "utf8"));
            if (Date.parse(meta.expiresAt) <= Date.now() || (!meta.published && Date.parse(meta.createdAt) < Date.now() - 86400000))
              await rm(this.path(id, ""), { recursive: true, force: true });
          });
        }
      } catch (error) {
        // A concurrent revoke is expected. One damaged directory must not stop
        // expiration of every other share.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      }
    }
    if (failed) throw new Error("Some share directories could not be cleaned");
  }
}

export function publicMeta(meta: ShareMeta) {
  return { id: meta.id, title: meta.title, createdAt: meta.createdAt, expiresAt: meta.expiresAt,
    published: meta.published, messageCount: meta.messageCount, files: meta.files.map(({ id, name, size }) => ({ id, name, size })) };
}

export function shareOwner(key: string) { return createHash("sha256").update("miniq-share-owner-v1\0").update(key).digest("hex"); }
