/** Return true when a provider failure points to billing or quota state. */
export function isBillingError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();
  return (
    /\b402\b/.test(normalized) ||
    [
      "insufficient_quota",
      "insufficient quota",
      "billing_not_active",
      "billing not active",
      "credit_balance_too_low",
      "credit balance too low",
      "usage_limit_reached",
      "usage limit reached",
      "billing hard limit",
      "insufficient_balance",
      "insufficient balance",
      "余额不足",
      "额度不足",
      "渠道欠费",
      "账户欠费",
    ].some((marker) => normalized.includes(marker))
  );
}

/** Convert transport/provider failures into copy a person can act on.
 * Keep the raw message available to callers that explicitly need diagnostics;
 * normal UI error surfaces should use this helper. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();
  if (isBillingError(error)) {
    return "在问 API Key 的余额或调用额度不足，请充值或更换 API Key。";
  }
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
