import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderMediaHttp } from "./providerMediaHttp.js";
import { shareOwner } from "./shareStore.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of close.splice(0)) await dispose(); });
async function fixture() {
  const issue = vi.fn(async () => ({ putUrl: "https://storage.test/put", getUrl: "https://storage.test/get", expiresAt: Date.now() + 900_000 }));
  const auth = vi.fn(async (key: string) => key === "valid-fixture-key");
  const handler = new ProviderMediaHttp({ enabledFor: () => false, ticket: vi.fn(), authenticatedMediaTicket: issue }, auth);
  const server = createServer((req, res) => void handler.handle(req, res));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  close.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/provider-media/ticket`;
  const post = (body: unknown, key = "valid-fixture-key") => fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  return { post, issue, auth };
}
it("authenticates tickets without remote access and derives owner server-side", async () => {
  const f = await fixture();
  const r = await f.post({ bytes: 1024, contentType: "image/png" });
  expect(r.status).toBe(200);
  expect(f.issue).toHaveBeenCalledWith(shareOwner("valid-fixture-key"), 1024, "image/png");
  expect(JSON.stringify(await r.json())).not.toContain("valid-fixture-key");
});
it("rejects an invalid key without issuing a ticket", async () => {
  const f = await fixture();
  expect((await f.post({ bytes: 1024, contentType: "image/png" }, "invalid-fixture-key")).status).toBe(401);
  expect(f.issue).not.toHaveBeenCalled();
});
it("rejects unsupported MIME, oversized files and injected object ownership", async () => {
  const f = await fixture();
  for (const body of [
    { bytes: 1, contentType: "text/html" },
    { bytes: 0, contentType: "image/png" },
    { bytes: 257 * 1024 * 1024, contentType: "video/mp4" },
    { bytes: 1, contentType: "image/png", owner: "other" },
  ]) expect((await f.post(body)).status).toBe(400);
  expect(f.issue).not.toHaveBeenCalled();
});
it("reserves per-account quota across requests and releases failed signing", async () => {
  const f = await fixture();
  f.issue.mockRejectedValueOnce(new Error("signed URL must stay hidden"));
  const failed = await f.post({ bytes: 200 * 1024 * 1024, contentType: "video/mp4" });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("signed URL");
  expect((await f.post({ bytes: 256 * 1024 * 1024, contentType: "video/mp4" })).status).toBe(200);
  expect((await f.post({ bytes: 256 * 1024 * 1024, contentType: "video/mp4" })).status).toBe(200);
  expect((await f.post({ bytes: 1, contentType: "image/png" })).status).toBe(429);
});
