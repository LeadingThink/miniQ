import { expect, it } from "vitest";
import { canFallbackRemoteFile, remoteFileErrorKind, remoteFileErrorMessage } from "./remoteFileErrors";

it.each([
  new Error("文件传输失败 (401)"),
  new Error("文件传输失败 (403)"),
  new Error("ticket expired (HTTP 403)"),
  new Error("Forbidden"),
  { status: 403, message: "Failed to fetch" },
])("does not fallback for ambiguous authorization failures: %s", cause => {
  expect(remoteFileErrorKind(cause)).toBe("permission");
  expect(canFallbackRemoteFile(cause)).toBe(false);
});
it.each([
  "File too large: maximum 200 MiB",
  "当前连接仅支持不超过 256 KiB 的文本预览",
  "当前手机单文件预览与下载上限为 200 MB",
])("preserves size limit details: %s", message => {
  expect(remoteFileErrorMessage(new Error(message))).toBe(message);
  expect(canFallbackRemoteFile(new Error(message))).toBe(false);
});
it("distinguishes budget exhaustion from file size limits", () => {
  expect(remoteFileErrorKind(new Error("Transfer budget exhausted"))).toBe("budget");
  expect(remoteFileErrorMessage(new Error("Transfer budget exhausted"))).toContain("预算不足");
});
it("does not classify generic invalid params as storage failure", () => {
  expect(canFallbackRemoteFile({code: -32602, message: "Invalid params"})).toBe(false);
  expect(canFallbackRemoteFile({code: -32602, message: "File storage unavailable"})).toBe(true);
});
