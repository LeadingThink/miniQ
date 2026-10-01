import { describe, expect, it } from "vitest";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
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
});
