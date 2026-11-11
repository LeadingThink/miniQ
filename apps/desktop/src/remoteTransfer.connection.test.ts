import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HostRpcClient } from "./hostRpc";
import { RpcClient } from "./rpc";
import { uploadRemoteFile } from "./remoteTransfer";
import type { RemoteUploadSource } from "./remoteUploadSource";
import { FakeWebSocket } from "./testSupport/rpcSocket";

const native = vi.hoisted(() => ({ readNativeUploadChunk: vi.fn() }));
vi.mock("./nativeFileTransfer", () => native);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function fixture(bytes = new Uint8Array([0, 255, 128, 7]), workspace = false) {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
  const root = new RpcClient();
  const connecting = root.connect({ kind: "local", port: 9000, token: "fixture" });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;
  const client = new HostRpcClient(root, "upgraded-host");
  const source: RemoteUploadSource = {
    kind: "browser", name: "imu_edges.csv", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    file: new File([bytes], "imu_edges.csv"), release: vi.fn(async () => {}),
  };
  const scope = workspace ? { workspaceId: "project" } : { sessionId: "session" };
  const uploaded: Uint8Array[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const receipt = { status: "completed", path: "/project/inbox/imu_edges.csv", size: source.size, sha256: source.sha256 };
  let prepare = () => ({ transport: "connection", transferId: "upload", chunkBytes: 2, expiresAt: Date.now() + 60000 });
  let write = (params: Record<string, unknown>) => {
    const bytes = new Uint8Array(Buffer.from(params.dataBase64 as string, "base64"));
    uploaded.push(bytes);
    return { nextOffset: (params.offset as number) + bytes.length };
  };
  const send = socket.send.bind(socket);
  socket.send = payload => {
    send(payload);
    const request = JSON.parse(payload);
    expect(request.method).toBe("host.call");
    expect(request.params.hostId).toBe("upgraded-host");
    const { method, params } = request.params;
    calls.push({ method, params });
    const result = method === "file.upload.prepare" ? prepare()
      : method === "file.upload.write" ? write(params)
        : method === "file.upload.commit" ? receipt : { status: "cancelled" };
    queueMicrotask(() => socket.receive({ jsonrpc: "2.0", id: request.id, result }));
  };
  return { client, root, source, scope, calls, uploaded, receipt,
    prepare: (value: typeof prepare) => { prepare = value; },
    write: (value: typeof write) => { write = value; },
  };
}

it.each([false, true])("uploads over an upgraded SSH host's RPC connection (workspace=%s)", async workspace => {
  const f = await fixture(undefined, workspace);
  const xhr = vi.fn();
  vi.stubGlobal("XMLHttpRequest", xhr);
  const progress = vi.fn();
  try {
    await expect(uploadRemoteFile(f.client, f.scope, f.source, undefined, progress)).resolves.toEqual(f.receipt);
    expect(f.uploaded).toEqual([new Uint8Array([0, 255]), new Uint8Array([128, 7])]);
    expect(f.calls.map(call => call.method)).toEqual([
      "file.upload.prepare", "file.upload.write", "file.upload.write", "file.upload.commit",
    ]);
    for (const call of f.calls) expect(call.params).toMatchObject(f.scope);
    expect(progress.mock.calls).toEqual([[2, 4], [4, 4]]);
    expect(xhr).not.toHaveBeenCalled();
  } finally { f.root.disconnect(); }
});

it("commits an empty SSH file without writing a block", async () => {
  const f = await fixture(new Uint8Array());
  try {
    await expect(uploadRemoteFile(f.client, f.scope, f.source)).resolves.toEqual(f.receipt);
    expect(f.calls.map(call => call.method)).toEqual(["file.upload.prepare", "file.upload.commit"]);
  } finally { f.root.disconnect(); }
});

it("keeps a multi-block binary original intact at the 256 KiB block boundary", async () => {
  const bytes = Uint8Array.from({ length: 700001 }, (_, index) => index % 251);
  const f = await fixture(bytes);
  f.prepare(() => ({ transport: "connection", transferId: "upload", chunkBytes: 262144, expiresAt: Date.now() + 60000 }));
  try {
    await expect(uploadRemoteFile(f.client, f.scope, f.source)).resolves.toEqual(f.receipt);
    expect(f.uploaded.map(block => block.length)).toEqual([262144, 262144, 175713]);
    expect(Buffer.concat(f.uploaded)).toEqual(Buffer.from(bytes));
  } finally { f.root.disconnect(); }
});

it("rejects a mismatched block receipt and cancels without committing", async () => {
  const f = await fixture();
  f.write(() => ({ nextOffset: 3 }));
  try {
    await expect(uploadRemoteFile(f.client, f.scope, f.source)).rejects.toThrow("文件分块回执校验失败");
    expect(f.calls.map(call => call.method)).toEqual(["file.upload.prepare", "file.upload.write", "file.transfer.cancel"]);
  } finally { f.root.disconnect(); }
});

it.each([0, 262145, 1.5, NaN])("rejects invalid connection block size %s before reading bytes", async chunkBytes => {
  const f = await fixture();
  f.prepare(() => ({ transport: "connection", transferId: "upload", chunkBytes, expiresAt: Date.now() + 60000 }));
  const read = vi.spyOn(f.source.file, "slice");
  try {
    await expect(uploadRemoteFile(f.client, f.scope, f.source)).rejects.toThrow("文件上传传输信息无效");
    expect(f.calls.map(call => call.method)).toEqual(["file.upload.prepare", "file.transfer.cancel"]);
    expect(read).not.toHaveBeenCalled();
  } finally { f.root.disconnect(); }
});

it("reads native originals in bounded chunks without an object-storage PUT", async () => {
  const f = await fixture();
  const source: RemoteUploadSource = { ...f.source, kind: "native", id: "cached-original" };
  native.readNativeUploadChunk.mockImplementation(async (_id, offset, length) =>
    Buffer.from([0, 255, 128, 7].slice(offset, offset + length)).toString("base64"));
  try {
    await expect(uploadRemoteFile(f.client, f.scope, source)).resolves.toEqual(f.receipt);
    expect(native.readNativeUploadChunk.mock.calls).toEqual([
      ["cached-original", 0, 2, undefined], ["cached-original", 2, 2, undefined],
    ]);
    expect(source.release).not.toHaveBeenCalled();
  } finally { f.root.disconnect(); }
});

it.each(["prepare", "write"])("cancels an SSH upload aborted during %s without committing", async stage => {
  const f = await fixture();
  const controller = new AbortController();
  if (stage === "prepare") f.prepare(() => {
    controller.abort();
    return { transport: "connection", transferId: "upload", chunkBytes: 2, expiresAt: Date.now() + 60000 };
  });
  else f.write(() => { controller.abort(); return { nextOffset: 2 }; });
  try {
    await expect(uploadRemoteFile(f.client, f.scope, f.source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls.filter(call => call.method === "file.transfer.cancel")).toHaveLength(1);
    expect(f.calls.some(call => call.method === "file.upload.commit")).toBe(false);
  } finally { f.root.disconnect(); }
});

it("recognizes an unknown upload method through the actual host.call error envelope", async () => {
  const f = await fixture();
  const socket = FakeWebSocket.instances[0];
  socket.send = payload => {
    const request = JSON.parse(payload);
    expect(request.method).toBe("host.call");
    queueMicrotask(() => socket.receive({ jsonrpc: "2.0", id: request.id, error: {
      code: -32601, message: "unknown method: file.upload.prepare",
    } }));
  };
  try {
    await expect(uploadRemoteFile(f.client, f.scope, f.source)).rejects.toMatchObject({
      message: expect.stringContaining("目标 miniQ 后台未提供文件上传接口"),
      cause: { method: "host.call", code: -32601 },
    });
  } finally { f.root.disconnect(); }
});
