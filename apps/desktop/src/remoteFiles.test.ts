import { describe, expect, it, vi } from "vitest";
import { readRemoteFile } from "./remoteFiles";

function source(bytes: Uint8Array, kind = "pdf", chunkBytes = 6) {
  const call = vi.fn(async (method: string, raw: unknown) => {
    const input = raw as { offset: number };
    if (method === "file.describe")
      return {
        path: "/work/报告",
        kind,
        mimeType: "application/pdf",
        size: bytes.length,
        revision: "v1",
        chunkBytes,
        maxPreviewBytes: 64 * 1024 * 1024,
      };
    const part = bytes.subarray(input.offset, input.offset + chunkBytes);
    return {
      offset: input.offset,
      nextOffset: input.offset + part.length,
      totalBytes: bytes.length,
      revision: "v1",
      done: input.offset + part.length === bytes.length,
      dataBase64: btoa(String.fromCharCode(...part)),
    };
  });
  return {
    mode: "remote" as const,
    call: call as ReturnType<typeof vi.fn> & {
      <T>(method: string, input?: unknown, options?: unknown): Promise<T>;
    },
  };
}

describe("remote artifact reads", () => {
  it("assembles all binary chunks and reports progress", async () => {
    const bytes = Uint8Array.from({ length: 19 }, (_, i) => i);
    const client = source(bytes);
    const progress = vi.fn();
    const result = await readRemoteFile("报告.pdf", {
      client,
      sessionId: "s1",
      onProgress: progress,
    });
    expect(atob(result.dataBase64!)).toBe(String.fromCharCode(...bytes));
    expect(progress).toHaveBeenLastCalledWith(19, 19);
    expect(
      client.call.mock.calls.filter((call) => call[0] === "file.read"),
    ).toHaveLength(4);
    expect(
      client.call.mock.calls.every(
        (call) => (call[1] as { sessionId: string }).sessionId === "s1",
      ),
    ).toBe(true);
  });
  it("preserves Chinese text split inside UTF-8 characters", async () => {
    const content = "# 中文文件\n表格、公式与二次修改\n";
    const client = source(new TextEncoder().encode(content), "markdown", 5);
    const result = await readRemoteFile("报告.md", { client, sessionId: "s1" });
    expect(result.content).toBe(content);
    expect(result.dataBase64).toBeNull();
  });
  it("stops requesting chunks when the preview is closed", async () => {
    const controller = new AbortController();
    const client = source(new Uint8Array(19));
    await expect(
      readRemoteFile("file.pdf", {
        client,
        sessionId: "s1",
        signal: controller.signal,
        onProgress: (received) => {
          if (received) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      client.call.mock.calls.filter((call) => call[0] === "file.read"),
    ).toHaveLength(1);
  });
  it("rejects a changed file or malformed offset without returning partial data", async () => {
    const client = source(new Uint8Array(19));
    const original = client.call.getMockImplementation()! as (
      method: string,
      raw: unknown,
    ) => Promise<Record<string, unknown>>;
    client.call.mockImplementation(async (method, raw) => {
      const value = await original(method, raw);
      return method === "file.read"
        ? { ...value, revision: "new revision" }
        : value;
    });
    await expect(
      readRemoteFile("file.pdf", { client, sessionId: "s1" }),
    ).rejects.toThrow("不完整");
  });
  it("does not download unsupported files until explicitly requested", async () => {
    const client = source(new Uint8Array([1, 2, 3]), "unsupported");
    expect(
      (await readRemoteFile("file.zip", { client, sessionId: "s1" }))
        .dataBase64,
    ).toBeNull();
    expect(client.call).toHaveBeenCalledTimes(1);
    expect(
      (
        await readRemoteFile("file.zip", {
          client,
          sessionId: "s1",
          download: true,
        })
      ).dataBase64,
    ).toBe("AQID");
  });
  it("rejects oversized files before downloading any content", async () => {
    const client = source(new Uint8Array());
    client.call.mockResolvedValue({
      path: "/work/large.mp4",
      kind: "video",
      size: 65 * 1024 * 1024,
      revision: "v1",
      chunkBytes: 3 * 1024 * 1024,
    });
    await expect(
      readRemoteFile("large.mp4", { client, sessionId: "s1" }),
    ).rejects.toThrow("64 MB");
    expect(client.call).toHaveBeenCalledTimes(1);
  });
});
