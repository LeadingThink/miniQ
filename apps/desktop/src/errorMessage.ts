/** Convert transport/provider failures into copy a person can act on.
 * Keep the raw message available to callers that explicitly need diagnostics;
 * normal UI error surfaces should use this helper. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();
  if (/\b(401|unauthorized)\b/.test(normalized)) {
    return "登录已过期或凭据无效，请重新登录后重试。";
  }
  if (/\b(403|forbidden)\b/.test(normalized)) {
    return "当前凭据没有执行此操作的权限，请检查权限后重试。";
  }
  if (normalized === "not connected" || /\bwebsocket\b.*\b(closed|disconnected|not connected)\b/.test(normalized)) {
    return "与 miniQ 的连接已断开，请检查连接后重试。";
  }
  return raw;
}
