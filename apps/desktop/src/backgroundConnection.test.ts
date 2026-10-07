// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "android",
  checkPermissions: vi.fn(async () => ({ display: "granted" })),
  requestPermissions: vi.fn(async () => ({ display: "granted" })),
  start: vi.fn(async () => ({ running: true, notificationsEnabled: true })),
  stop: vi.fn(async () => undefined),
  batteryStatus: vi.fn(async () => ({ unrestricted: false })),
  openBatterySettings: vi.fn(async () => undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.platform !== "web", getPlatform: () => native.platform },
  registerPlugin: () => native,
}));

vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: native }));

import {
  getBackgroundConnectionEnabled,
  isBackgroundConnectionSupported,
  isBatteryUnrestricted,
  setBackgroundConnectionEnabled,
  syncBackgroundConnection,
} from "./backgroundConnection";

beforeEach(() => {
  native.platform = "android";
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => localStorage.clear());

it("is off by default and only supported on Android", () => {
  expect(getBackgroundConnectionEnabled()).toBe(false);
  expect(isBackgroundConnectionSupported()).toBe(true);
  native.platform = "ios";
  expect(isBackgroundConnectionSupported()).toBe(false);
});

it("starts and stops the native service with the preference", async () => {
  await expect(setBackgroundConnectionEnabled(true)).resolves.toBe(true);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(getBackgroundConnectionEnabled()).toBe(true);

  await expect(setBackgroundConnectionEnabled(false)).resolves.toBe(false);
  expect(native.stop).toHaveBeenCalledTimes(1);
  expect(getBackgroundConnectionEnabled()).toBe(false);
});

it("restores the saved preference on launch and tolerates old APKs", async () => {
  localStorage.setItem("miniq.backgroundConnection.v1", "1");
  native.start.mockRejectedValueOnce(new Error("plugin not implemented"));
  await expect(syncBackgroundConnection()).resolves.toBe(false);
  await expect(syncBackgroundConnection()).resolves.toBe(true);
});

it("never touches the native plugin on iOS", async () => {
  native.platform = "ios";
  localStorage.setItem("miniq.backgroundConnection.v1", "1");
  await expect(syncBackgroundConnection()).resolves.toBe(false);
  await expect(isBatteryUnrestricted()).resolves.toBe(true);
  expect(native.start).not.toHaveBeenCalled();
  expect(native.batteryStatus).not.toHaveBeenCalled();
});

it("reports battery optimization status on Android", async () => {
  await expect(isBatteryUnrestricted()).resolves.toBe(false);
});

it("requests permission before starting and does not save a denied enable", async () => {
  native.checkPermissions.mockResolvedValueOnce({ display: "prompt" });
  native.requestPermissions.mockResolvedValueOnce({ display: "denied" });
  await expect(setBackgroundConnectionEnabled(true)).rejects.toThrow("允许 miniQ 发送通知");
  expect(native.requestPermissions).toHaveBeenCalledOnce();
  expect(native.start).not.toHaveBeenCalled();
  expect(getBackgroundConnectionEnabled()).toBe(false);
});

it("rolls back a failed foreground start even with a previously saved preference", async () => {
  localStorage.setItem("miniq.backgroundConnection.v1", "1");
  native.start.mockResolvedValueOnce({ running: false, notificationsEnabled: true });
  await expect(setBackgroundConnectionEnabled(true)).rejects.toThrow("未能启动");
  expect(getBackgroundConnectionEnabled()).toBe(false);
  expect(native.stop).toHaveBeenCalledOnce();
});

it("rejects a disabled notification channel even with runtime permission", async () => {
  native.start.mockResolvedValueOnce({ running: true, notificationsEnabled: false });
  await expect(setBackgroundConnectionEnabled(true)).rejects.toThrow("通知已被关闭");
  expect(getBackgroundConnectionEnabled()).toBe(false);
});

it("does not ask for permissions during automatic restoration", async () => {
  localStorage.setItem("miniq.backgroundConnection.v1", "1");
  await syncBackgroundConnection();
  expect(native.requestPermissions).not.toHaveBeenCalled();
});
