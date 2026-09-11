import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneApiShareAuth, ShareHttp } from "./shareHttp.js";
import { parseShare, ShareStore } from "./shareStore.js";

const id = "a".repeat(32), fileId = "b".repeat(32), scope = "c".repeat(64);
const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function input() {
  return { scope, title: "交付结果", expiresInDays: 30,
    messages: Array.from({ length: 123 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `消息 ${index}`, createdAt: "2026-09-11T00:00:00Z" })), files: [] };
}
async function start(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), "miniq-share-test-")); directories.push(root);
  const store = new ShareStore(root);
  const http = new ShareHttp(store, async (key) => key === "test-owner-key" || key === "other-owner-key");
  const server = createServer((request, response) => void http.handle(request, response)); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/shares`;
  const call = (path: string, method = "GET", body?: unknown, key = "test-owner-key", extra: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-share-scope": scope, ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { call, base, root, store };
}

describe("public session shares", () => {
  it("requires an explicit identity response and caches only successful validation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const auth = oneApiShareAuth();
    expect(await auth("test-owner-key")).toBe(false);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ valid: true }), { status: 200 }));
    expect(await auth("test-owner-key")).toBe(true);
    expect(await auth("test-owner-key")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith("https://oneapi.zaiwenai.com/v1/auth/key", expect.objectContaining({ redirect: "error" }));
  });
  it("publishes complete paged snapshots, survives restart, isolates management and revokes immediately", async () => {
    const { call, base, root } = await start();
    expect((await call(`/${id}`, "PUT", input())).status).toBe(200);
    expect((await fetch(`${base}/${id}`)).status).toBe(404);
    expect((await call(`/${id}/publish`, "POST")).status).toBe(200);
    const restarted = await start(root);
    let page: number | null = 0; const messages = [];
    do {
      const response = await fetch(`${restarted.base}/${id}?page=${page}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.owner).toBeUndefined(); expect(body.scope).toBeUndefined(); expect(body.fingerprint).toBeUndefined();
      messages.push(...body.messages); page = body.nextPage;
    } while (page !== null);
    expect(messages).toEqual(input().messages);
    expect((await call(`/manage?scope=${scope}`, "GET", undefined, "other-owner-key").then((r) => r.json())).shares).toEqual([]);
    expect((await call(`/${id}`, "DELETE", undefined, "other-owner-key")).status).toBe(404);
    expect((await call(`/${id}`, "DELETE", undefined, "test-owner-key", { "x-share-scope": "wrong-session" })).status).toBe(404);
    expect((await call(`/${id}`, "DELETE")).status).toBe(200);
    expect((await fetch(`${base}/${id}`)).status).toBe(404);
  });

  it("verifies file bytes before publication, supports video ranges, and never permits changing published files", async () => {
    const { call, base } = await start(); const bytes = Buffer.from("test-video-content");
    const data = { ...input(), files: [{ id: fileId, name: "演示.mp4", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] };
    await call(`/${id}`, "PUT", data);
    expect((await call(`/${id}/publish`, "POST")).status).toBe(409);
    const upload = (body: Buffer) => fetch(`${base}/${id}/files/${fileId}`, { method: "PUT", headers: { authorization: "Bearer test-owner-key" }, body });
    expect((await upload(Buffer.alloc(bytes.length))).status).toBe(409);
    expect((await upload(bytes)).status).toBe(200);
    await call(`/${id}/publish`, "POST");
    const part = await fetch(`${base}/${id}/files/${fileId}`, { headers: { range: "bytes=5-9" } });
    expect(part.status).toBe(206); expect(await part.text()).toBe(bytes.subarray(5, 10).toString());
    expect(part.headers.get("content-range")).toBe(`bytes 5-9/${bytes.length}`);
    expect((await upload(bytes)).status).toBe(409);
    expect((await fetch(`${base}/${id}/files/${fileId}`, { headers: { range: "bytes=99-100" } })).status).toBe(416);
    expect((await fetch(`${base}/${id}/files/${"f".repeat(32)}`)).status).toBe(404);
    await call(`/${id}`, "DELETE");
    expect((await fetch(`${base}/${id}/files/${fileId}`)).status).toBe(404);
  });

  it("requires a valid key, rejects internal roles and traversal, and retries without duplicate snapshots", async () => {
    const { call } = await start();
    expect((await call(`/${id}`, "PUT", input(), "invalid-key")).status).toBe(401);
    expect((await call(`/${id}`, "PUT", { ...input(), messages: [{ role: "system", content: "secret", createdAt: "2026-09-11" }] })).status).toBe(400);
    expect(() => parseShare({ ...input(), files: [{ id: fileId, name: "../secret", size: 0, sha256: "a".repeat(64) }] })).toThrow();
    const first = await call(`/${id}`, "PUT", input()).then((r) => r.json());
    const second = await call(`/${id}`, "PUT", input()).then((r) => r.json());
    expect(second).toEqual(first);
    expect((await call(`/${id}`, "PUT", { ...input(), title: "different snapshot" })).status).toBe(409);
    expect((await call(`/manage?scope=${scope}`).then((r) => r.json())).shares).toHaveLength(1);
    const safe = parseShare({ ...input(), apiKey: "do-not-copy", tools: ["secret"] });
    expect(safe).not.toHaveProperty("apiKey"); expect(safe).not.toHaveProperty("tools");
  });

  it("reserves owner quota across concurrent snapshot IDs", async () => {
    const { store } = await start();
    const data = parseShare({ ...input(), files: ["b", "c"].map((letter) => ({ id: letter.repeat(32), name: `${letter}.mp4`, size: 256 * 1024 * 1024, sha256: "d".repeat(64) })) });
    for (let i = 1; i <= 3; i++) await store.create(String(i).repeat(32), "owner", data);
    const attempts = await Promise.allSettled([4, 5].map((i) => store.create(String(i).repeat(32), "owner", data)));
    expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect((await store.list("owner", scope, "")).shares).toHaveLength(4);
  });

  it("expires snapshots and stale uploads, including scratch directories left by interrupted writes", async () => {
    const { store, root } = await start();
    const draftId = "b".repeat(32), activeId = "c".repeat(32);
    for (const value of [id, draftId, activeId]) await store.create(value, "owner", parseShare(input()));
    await store.publish(id, "owner"); await store.publish(activeId, "owner");
    const expired = JSON.parse(await readFile(store.path(id, "meta.json"), "utf8"));
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(store.path(id, "meta.json"), JSON.stringify(expired));
    const stale = JSON.parse(await readFile(store.path(draftId, "meta.json"), "utf8"));
    stale.createdAt = new Date(Date.now() - 2 * 86400000).toISOString();
    await writeFile(store.path(draftId, "meta.json"), JSON.stringify(stale));
    const scratch = join(root, `.draft-${"d".repeat(32)}`);
    await mkdir(scratch); await utimes(scratch, new Date(0), new Date(0));
    expect(await store.page(id, 0).catch((error) => error.status)).toBe(404);
    await store.cleanup();
    expect(await readdir(root)).toEqual([activeId]);
    expect((await store.page(activeId, 0)).messages).toHaveLength(50);
  });
});
