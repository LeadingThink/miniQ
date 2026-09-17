import { describe, expect, it } from "vitest";
import { connectionFailureMessage, connectionRetryDelay } from "./useDaemonConnection";

describe("connectionRetryDelay", () => {
  it("backs off quickly and caps reconnect latency", () => {
    expect([1, 2, 3, 4, 5, 6].map(connectionRetryDelay)).toEqual([
      500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });
});

describe("connectionFailureMessage", () => {
  it("does not call the initial local connection a reconnect", () => {
    expect(connectionFailureMessage(new Error("后台服务未就绪"), false)).toBe(
      "后台服务未就绪，正在继续尝试连接 miniQ 服务",
    );
  });

  it("labels an established connection recovery as a reconnect", () => {
    expect(connectionFailureMessage(new Error("连接已断开"), true)).toBe(
      "连接已断开，miniQ 正在自动重连",
    );
  });
});
