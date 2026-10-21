import { afterEach, expect, it, vi } from "vitest";
import { putNativeUploadFile } from "./nativeFileTransfer";
import type { RpcClient } from "./rpc";
import { uploadRemoteFile } from "./remoteTransfer";
import { RpcResponseError } from "./rpcError";
import type { RemoteUploadSource } from "./remoteUploadSource";

vi.mock("./nativeFileTransfer", () => ({ putNativeUploadFile: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => vi.clearAllMocks());

const source: RemoteUploadSource = {
  kind: "native", id: "original-file", name: "IMG_5424.png", size: 4,
  sha256: "a".repeat(64), release: async () => {},
};
const undeclared = {
  code: "REMOTE_FORBIDDEN", reason: "undeclared", host_command: "file.upload.prepare",
};

it.each([
  { label: "undeclared upload prepare", error: new RpcResponseError("file.upload.prepare", {
    code: -32000, message: "该操作未开放远程访问，请在桌面端执行", data: undeclared,
  }) },
  { label: "unknown upload prepare", error: new RpcResponseError("file.upload.prepare", {
    code: -32601, message: "unknown method: file.upload.prepare",
  }) },
])("explains the device update needed for $label without extra RPCs", async ({ error }) => {
  const call = vi.fn().mockRejectedValue(error);
  await expect(uploadRemoteFile({ call }, { workspaceId: "ubuntu" }, source)).rejects.toMatchObject({
    message: "当前连接的 miniQ 后台暂不支持手机文件上传。请在该电脑或服务器运行 miniq doctor 检查 daemon 版本，完成更新后重试；如有任务正在运行，请先等待任务结束。",
    cause: error,
  });
  expect(call).toHaveBeenCalledExactlyOnceWith("file.upload.prepare", {
    workspaceId: "ubuntu", name: source.name, size: source.size, sha256: source.sha256,
  }, { timeoutMs: 600000 });
  expect(putNativeUploadFile).not.toHaveBeenCalled();
});

it.each([
  { label: "host-only policy", error: new RpcResponseError("file.upload.prepare", {
    code: -32000, message: "该管理操作只能在桌面端执行", data: { ...undeclared, reason: "host_only" },
  }) },
  { label: "forbidden credentials", error: new RpcResponseError("file.upload.prepare", {
    code: 403, message: "forbidden",
  }) },
  { label: "another undeclared method", error: new RpcResponseError("file.upload.prepare", {
    code: -32000, message: "该操作未开放远程访问，请在桌面端执行",
    data: { ...undeclared, host_command: "file.download.prepare" },
  }) },
  { label: "missing host forwarding", error: new RpcResponseError("host.call", {
    code: -32601, message: "unknown method: host.call",
  }) },
  { label: "unstructured remote refusal", error: new Error("该操作未开放远程访问，请在桌面端执行 (code -32000)") },
])("preserves $label instead of presenting an update diagnosis", async ({ error }) => {
  const call = vi.fn().mockRejectedValue(error);
  await expect(uploadRemoteFile({ call }, { sessionId: "session" }, source)).rejects.toBe(error);
  expect(call).toHaveBeenCalledTimes(1);
});

it("preserves commit failures even when their data names upload prepare", async () => {
  const error = new RpcResponseError("file.upload.commit", {
    code: -32000, message: "该操作未开放远程访问，请在桌面端执行", data: undeclared,
  });
  const call = vi.fn(async (method: string) => {
    if (method === "file.upload.prepare") return {
      transferId: "transfer", putUrl: "https://bucket.qiniucs.com/remote-files/room/file",
      expiresAt: Date.now() + 60000,
    };
    if (method === "file.upload.commit") throw error;
    return { status: "cancelled" };
  });
  await expect(uploadRemoteFile({ call: call as RpcClient["call"] }, { sessionId: "session" }, source)).rejects.toBe(error);
  expect(call).toHaveBeenLastCalledWith("file.transfer.cancel", { sessionId: "session", transferId: "transfer" });
});
