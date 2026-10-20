function message(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return cause.message;
  return String(cause);
}
export type RemoteFileErrorKind = "permission" | "storage" | "budget" | "ticket" | "network" | "cancelled" | "integrity" | "unknown";
export function remoteFileErrorKind(cause: unknown): RemoteFileErrorKind {
  const text = message(cause);
  if (cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError") return "cancelled";
  const status = cause && typeof cause === "object" && "status" in cause ? cause.status : undefined;
  if (status === 401 || status === 403 || /\b(?:401|403)\b|forbidden|permission denied|access denied|not authorized|unauthorized|outside.*workspace|not.*authorized|权限|未授权|无权/i.test(text)) return "permission";
  if (/revision|file changed|integrity|incomplete|exceeds declared|checksum|sha.?256|版本|大小已变化|完整性|不完整|超出声明|传输信息无效|对象地址无效|文件信息无效/i.test(text)) return "integrity";
  if (/cancelled|canceled|取消/i.test(text)) return "cancelled";
  if (/too large|size limit|大小上限|容量|上限|超过.*(?:MB|MiB|KiB)|超出.*限制/i.test(text)) return "unknown";
  if (/budget|quota|预算|配额/i.test(text)) return "budget";
  if (/File storage unavailable|storage (?:service )?(?:unavailable|not configured|signing failed)|存储服务不可用|存储服务未返回有效分段/i.test(text)) return "storage";
  if (/(?:ticket|签名|票据).*(?:expired|unavailable|request failed|timed out|过期|失败)|(?:下载|预览)链接.*(?:过期|刷新失败)/i.test(text)) return "ticket";
  if (/Failed to fetch|NetworkError|network (?:error|request failed)|File connection closed|File peer disconnected|Load failed|fetch failed|网络|文件传输失败 \((?:0|404|408|429|5\d\d)\)/i.test(text)) return "network";
  return "unknown";
}
export function canFallbackRemoteFile(cause: unknown): boolean {
  return ["storage", "ticket", "network"].includes(remoteFileErrorKind(cause));
}
export function remoteFileErrorMessage(cause: unknown): string {
  if (/Invalid file ticket request/i.test(message(cause))) return "文件传输参数与中继不兼容，请更新电脑上的 miniQ 后重试";
  const labels: Partial<Record<RemoteFileErrorKind, string>> = {
    permission: "没有权限读取此文件，请检查当前会话的文件授权",
    storage: "文件存储服务暂不可用，请稍后重试",
    budget: "短时文件传输预算不足，请等待约 1 分钟后重试",
    ticket: "文件下载票据不可用或已过期，请重新加载",
    network: "文件传输网络连接失败，请检查连接后重试",
  };
  return labels[remoteFileErrorKind(cause)] ?? message(cause);
}
