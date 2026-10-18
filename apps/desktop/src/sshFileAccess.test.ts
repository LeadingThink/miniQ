import { afterEach, expect, it, vi } from "vitest";
import { readImagePreview, readLocalFilePreview } from "./localFiles";
import type { RpcClient } from "./rpc";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => true }));
afterEach(() => vi.resetAllMocks());

it.each(["text", "image"])(
  "reads remote %s bytes over RPC even inside the local native app",
  async (kind) => {
    const path = `/same/path/file.${kind === "text" ? "txt" : "png"}`;
    const mimeType = kind === "text" ? "text/plain" : "image/png";
    const call = vi.fn(async (method: string) =>
      method === "file.describe"
        ? {
            path,
            kind,
            mimeType,
            size: 3,
            revision: "remote-rev",
            chunkBytes: 3,
            maxPreviewBytes: 100,
            ...(kind === "image" ? { getUrl: "https://s3.example.qiniucs.com/remote-files/a/x", transferId: "t", expiresAt: Date.now() + 60000, size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" } : {}),
          }
        : method === "file.download.prepare"
          ? { transferId: "t", getUrl: "https://s3.example.qiniucs.com/remote-files/a/x", expiresAt: Date.now() + 60000, size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", revision: "remote-rev" }
        : {
            offset: 0,
            nextOffset: 3,
            totalBytes: 3,
            revision: "remote-rev",
            done: true,
            dataBase64: "YWJj",
          },
    );
    const client = { mode: "remote", call } as unknown as RpcClient;
    const access = { client, sessionId: "remote-session" };
    const file =
      kind === "text"
        ? await readLocalFilePreview(path, "/same/path", [], access)
        : await readImagePreview(path, access);
    expect(file).toMatchObject(
      kind === "text" ? { content: "abc" } : { mimeType, remoteSource: expect.objectContaining({ getUrl: expect.stringContaining("qiniucs.com") }) },
    );
    expect(call).toHaveBeenCalledWith(
      "file.describe",
      { sessionId: "remote-session", path },
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalled();
  },
);
