// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "android",
  start: vi.fn(async () => ({ running: true })),
  stop: vi.fn(async () => undefined),
  batteryStatus: vi.fn(async () => ({ unrestricted: false })),
  openBatterySettings: vi.fn(async () => undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.platform !== "web", getPlatform: () => native.platform },
  registerPlugin: () => native,
}));

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
