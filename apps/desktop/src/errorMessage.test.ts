import { describe, expect, it } from "vitest";
import { billingErrorKind, errorMessage, isBillingError } from "./errorMessage";

describe("errorMessage", () => {
  it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])(
    "explains a browser network failure: %s", (message) => {
      expect(errorMessage(new TypeError(message))).toBe("无法连接服务，请检查网络后重试。");
    },
  );
  it.each([
    "401 Unauthorized (code -32000)",
    "provider returned 401",
    "unauthorized",
  ])("explains expired credentials for %s", (message) => {
    expect(errorMessage(new Error(message))).toBe("登录已过期或凭据无效，请重新登录后重试。");
  });

  it("does not mistake a number embedded in another word for a status", () => {
    expect(errorMessage(new Error("request 4012 failed"))).toBe("request 4012 failed");
  });

  it.each(["request x401y failed", "unauthorizedOperation is undefined", "WebSocket payload exceeds size limit", "Connector not connected: reconnect your account"])(
    "preserves unrelated diagnostics: %s", (message) => {
      expect(errorMessage(new Error(message))).toBe(message);
    },
  );

  it("explains an explicit WebSocket disconnect", () => {
    expect(errorMessage(new Error("WebSocket closed"))).toContain("连接已断开");
  });

  it("keeps actionable permission and connection copy", () => {
    expect(errorMessage(new Error("403 Forbidden"))).toContain("没有执行此操作的权限");
    expect(errorMessage(new Error("not connected"))).toContain("连接已断开");
  });

  it.each([
    "provider returned 402",
    "insufficient_quota",
    "credit_balance_too_low",
    "余额不足",
    "渠道欠费",
  ])("recognizes billing failures: %s", (message) => {
    expect(isBillingError(new Error(message))).toBe(true);
    expect(errorMessage(new Error(message))).toBe("在问 API Key 的余额或调用额度不足，请充值或更换 API Key。");
  });

  it("classifies the gateway's 401 key quota error separately from a 402 balance error", () => {
    const keyQuota = new Error('provider error: provider returned 401: {"type":"error","error":{"message":"Key quota used up","type":"invalid_request_error","code":"key_quota_exceeded"}}');
    const balance = new Error('provider error: provider returned 402: {"type":"error","error":{"type":"insufficient_balance","message":"余额不足"}}');
    expect(billingErrorKind(keyQuota)).toBe("key-quota");
    expect(billingErrorKind(balance)).toBe("balance");
    expect(errorMessage(keyQuota)).toContain("Key 的额度已用完");
    expect(errorMessage(keyQuota)).not.toContain("登录已过期");
    expect(isBillingError(errorMessage(keyQuota))).toBe(true);
    expect(billingErrorKind(new Error("provider returned 401: invalid api key"))).toBeNull();
  });

  it("does not classify an unrelated 402-like number as billing", () => {
    expect(isBillingError(new Error("request 4020 failed"))).toBe(false);
  });
});
