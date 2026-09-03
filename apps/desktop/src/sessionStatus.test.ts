import { describe, expect, it } from "vitest";
import { isSessionRunning, isSessionTerminal, sessionStatusLabel } from "./sessionStatus";

describe("sessionStatusLabel", () => {
  it("uses user-facing Chinese status labels", () => {
    expect(sessionStatusLabel("idle")).toBe("空闲");
    expect(sessionStatusLabel("running")).toBe("执行中");
    expect(sessionStatusLabel("waiting_approval")).toBe("等待确认");
    expect(sessionStatusLabel("cancelling")).toBe("正在停止");
    expect(sessionStatusLabel("failed")).toBe("执行失败");
  });

  it("groups active and terminal states for attention indicators", () => {
    expect(isSessionRunning("running")).toBe(true);
    expect(isSessionRunning("waiting_approval")).toBe(true);
    expect(isSessionRunning("cancelling")).toBe(true);
    expect(isSessionRunning("idle")).toBe(false);
    expect(isSessionTerminal("idle")).toBe(true);
    expect(isSessionTerminal("failed")).toBe(true);
    expect(isSessionTerminal("running")).toBe(false);
  });
});
