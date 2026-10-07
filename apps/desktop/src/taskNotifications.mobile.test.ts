// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  schedule: vi.fn(async () => ({ notifications: [] })),
  checkPermissions: vi.fn(async () => ({ display: "granted" })),
  requestPermissions: vi.fn(async () => ({ display: "granted" })),
  createChannel: vi.fn(async () => undefined),
  impact: vi.fn(async () => undefined),
  notification: vi.fn(async () => undefined),
  markAppBadge: vi.fn(async () => 1),
  platform: "android",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => native.platform },
}));
vi.mock("./runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("./appBadge", () => ({ markAppBadge: native.markAppBadge }));
vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    schedule: native.schedule,
    checkPermissions: native.checkPermissions,
    requestPermissions: native.requestPermissions,
    createChannel: native.createChannel,
  },
}));
vi.mock("@capacitor/haptics", () => ({
  Haptics: { impact: native.impact, notification: native.notification },
  ImpactStyle: { Light: "LIGHT" },
  NotificationType: { Warning: "WARNING" },
}));

import { notificationId, notifyMobileTask, setTaskAttentionEnabled, setTaskNotificationMode } from "./taskNotifications";
import { dismissTaskBanner, getTaskBanner } from "./taskBanner";

let visibility: DocumentVisibilityState = "visible";
const target = { host: null, sessionId: "s1" };

beforeEach(() => {
  localStorage.clear();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  native.platform = "android";
  native.checkPermissions.mockResolvedValue({ display: "granted" });
  dismissTaskBanner();
});

afterEach(() => {
  vi.clearAllMocks();
  dismissTaskBanner();
});

describe("notifyMobileTask", () => {
  it("shows an in-app banner and a light haptic in the foreground", async () => {
    expect(await notifyMobileTask("completed", "整理报告", target, false)).toBe(true);
    expect(getTaskBanner()).toMatchObject({ kind: "completed", title: "miniQ · 任务完成", target });
    await vi.waitFor(() => expect(native.impact).toHaveBeenCalledWith({ style: "LIGHT" }));
    expect(native.schedule).not.toHaveBeenCalled();
    expect(native.markAppBadge).not.toHaveBeenCalled();
  });

  it("uses a warning haptic for sessions waiting on the user", async () => {
    await notifyMobileTask("attention", "部署", target, false);
    expect(getTaskBanner()?.title).toBe("miniQ · 需要你操作");
    await vi.waitFor(() => expect(native.notification).toHaveBeenCalledWith({ type: "WARNING" }));
  });

  it("skips the conversation that is on screen", async () => {
    expect(await notifyMobileTask("failed", "部署", target, true)).toBe(false);
    expect(getTaskBanner()).toBeNull();
  });

  it("posts a per-session system notification in the background", async () => {
    visibility = "hidden";
    expect(await notifyMobileTask("attention", "部署", { host: "mac", sessionId: "s1", targetDeviceId: "desktop-a" }, true)).toBe(true);
    expect(native.createChannel).toHaveBeenCalled();
    expect(native.schedule).toHaveBeenCalledWith({ notifications: [expect.objectContaining({
      id: notificationId({ host: "mac", sessionId: "s1", targetDeviceId: "desktop-a" }),
      title: "miniQ · 需要你操作",
      channelId: "miniq-attention",
      interruptionLevel: "timeSensitive",
      threadIdentifier: "session:s1",
      extra: { miniqTarget: { host: "mac", sessionId: "s1", targetDeviceId: "desktop-a" }, miniqTargetDeviceId: "desktop-a" },
    })] });
    expect(getTaskBanner()).toBeNull();
    expect(native.markAppBadge).toHaveBeenCalledWith("mac", "s1");
  });

  it("does not prompt for permission from the background", async () => {
    visibility = "hidden";
    native.checkPermissions.mockResolvedValue({ display: "prompt" });
    expect(await notifyMobileTask("failed", "部署", target, false)).toBe(false);
    expect(native.requestPermissions).not.toHaveBeenCalled();
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it("follows the mode and the attention switch", async () => {
    setTaskNotificationMode("failures");
    expect(await notifyMobileTask("completed", "a", target, false)).toBe(false);
    expect(await notifyMobileTask("attention", "a", target, false)).toBe(true);
    setTaskAttentionEnabled(false);
    expect(await notifyMobileTask("attention", "a", target, false)).toBe(false);
    setTaskNotificationMode("off");
    setTaskAttentionEnabled(true);
    expect(await notifyMobileTask("attention", "a", target, false)).toBe(false);
  });

  it("gives each session a stable, distinct notification id", () => {
    expect(notificationId(target)).toBe(notificationId({ ...target }));
    expect(notificationId(target)).not.toBe(notificationId({ host: "mac", sessionId: "s1" }));
    expect(notificationId({ ...target, targetDeviceId: "desktop-a" })).not.toBe(notificationId({ ...target, targetDeviceId: "desktop-b" }));
    expect(notificationId(target)).toBeGreaterThan(0);
  });
});
