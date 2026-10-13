import { expect, it, vi } from "vitest";
import { BlobStore } from "./blobStore.js";

vi.mock("qiniu", () => ({ default: {
  rs: { BucketManager: class { async getBucketInfo() { return { data: { private: 1, bucket_rules: [
    { prefix: "remote/", delete_after_days: 1 }, { prefix: "provider-media/", delete_after_days: 1 },
  ] }, resp: { statusCode: 200 } }; } } },
  auth: { digest: { Mac: class {} } }, conf: { Config: class {} },
} }));

it("binds actual provider-media PUT signatures to content type and length while preserving blob signatures", async () => {
  const roomId = "r".repeat(43);
  const store = new BlobStore({ accessKey: "test-access", secretKey: "test-secret", bucket: "test-private",
    endpoint: "https://s3-cn-east-1.qiniucs.com", region: "cn-east-1", rooms: [roomId] });
  const media = await store.providerMediaTicket(roomId, 1024, "image/png", "desktop-aaaa");
  const put = new URL(media.putUrl), get = new URL(media.getUrl);
  expect(put.pathname).toMatch(new RegExp(`^/test-private/provider-media/${roomId}/desktop-aaaa/[a-f0-9-]{36}$`));
  expect(put.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(expect.arrayContaining(["content-type", "content-length", "host"]));
  expect(put.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(get.pathname).toBe(put.pathname);
  expect(get.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(get.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(Object.keys(media).sort()).toEqual(["expiresAt", "getUrl", "putUrl"]);
  expect(JSON.stringify(media)).not.toContain("test-secret");
  const blob = await store.ticket(roomId, 1024, "desktop-aaaa");
  const blobPut = new URL(blob.putUrl);
  expect(blobPut.pathname).toMatch(new RegExp(`^/test-private/remote/${roomId}/desktop-aaaa/`));
  expect(blobPut.searchParams.get("X-Amz-Expires")).toBe("300");
  expect(blobPut.searchParams.get("X-Amz-SignedHeaders")?.split(";")).not.toContain("content-type");
});
