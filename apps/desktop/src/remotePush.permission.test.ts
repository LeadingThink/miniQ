// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "ios",
  mobile: true,
  pushRequest: vi.fn(async () => ({ receive: "granted" })),
  localRequest: vi.fn(async () => ({ display: "granted" })),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => native.mobile,
    getPlatform: () => native.platform,
    isPluginAvailable: () => true,
  },
  registerPlugin: () => ({}),
}));
vi.mock("./mobileRuntime", () => ({ isNativeMobileApp: () => native.mobile }));
vi.mock("./appBadge", () => ({ markAppBadge: vi.fn(async () => null) }));
vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: { requestPermissions: native.pushRequest },
}));
vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: { requestPermissions: native.localRequest },
}));

import { requestRemotePushPermission } from "./remotePush";

const refreshes = vi.fn();
beforeEach(() => {
  native.platform = "ios";
  native.mobile = true;
  window.addEventListener("miniq-remote-push-refresh", refreshes);
});
afterEach(() => {
  window.removeEventListener("miniq-remote-push-refresh", refreshes);
  vi.clearAllMocks();
});

it("asks APNs permission on iOS and re-runs registration", async () => {
  expect(await requestRemotePushPermission()).toBe(true);
  expect(native.pushRequest).toHaveBeenCalledTimes(1);
  expect(native.localRequest).not.toHaveBeenCalled();
  expect(refreshes).toHaveBeenCalledTimes(1);
});

it("asks notification permission on Android", async () => {
  native.platform = "android";
  native.localRequest.mockResolvedValueOnce({ display: "denied" });
  expect(await requestRemotePushPermission()).toBe(false);
  expect(native.localRequest).toHaveBeenCalledTimes(1);
  expect(refreshes).toHaveBeenCalledTimes(1);
});

it("treats a failing permission request as not granted", async () => {
  native.pushRequest.mockRejectedValueOnce(new Error("boom"));
  expect(await requestRemotePushPermission()).toBe(false);
  expect(refreshes).toHaveBeenCalledTimes(1);
});

it("does nothing outside the phone app", async () => {
  native.mobile = false;
  expect(await requestRemotePushPermission()).toBe(false);
  expect(native.pushRequest).not.toHaveBeenCalled();
  expect(refreshes).not.toHaveBeenCalled();
});
