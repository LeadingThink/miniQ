// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTaskNotificationMode,
  notifyTaskResult,
  requestTaskNotificationPermission,
  sendTaskNotificationTest,
  setTaskNotificationMode,
} from "./taskNotifications";

const platform = vi.hoisted(() => ({ native: false }));
const isWindowFocused = vi.hoisted(() => vi.fn());
const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("./runtime", () => ({ isTauriRuntime: () => platform.native }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: isWindowFocused }) }));
vi.mock("@tauri-apps/plugin-notification", () => plugin);
const web = Object.assign(vi.fn(function () {}), {
  permission: "granted" as NotificationPermission,
  requestPermission: vi.fn(),
});

beforeEach(() => {
  localStorage.clear();
  platform.native = false;
  isWindowFocused.mockReset().mockResolvedValue(false);
  web.mockClear();
  web.permission = "granted";
  web.requestPermission.mockReset().mockResolvedValue("granted");
  plugin.isPermissionGranted.mockReset().mockResolvedValue(true);
  plugin.requestPermission.mockReset().mockResolvedValue("granted");
  plugin.sendNotification.mockReset();
  vi.stubGlobal("Notification", web);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("background task notifications", () => {
  it("retains each notification mode across reads", () => {
    expect(getTaskNotificationMode()).toBe("all");
    for (const mode of ["failures", "off", "all"] as const) {
      setTaskNotificationMode(mode);
      expect(getTaskNotificationMode()).toBe(mode);
    }
  });

  it("shows completion and failure in all mode with clear Chinese punctuation", async () => {
    expect(await notifyTaskResult("completed", "制作海报")).toBe(true);
    expect(web).toHaveBeenLastCalledWith("miniQ · 任务完成", {
      body: "「制作海报」已完成，请返回 miniQ 查看结果。",
    });
    expect(await notifyTaskResult("failed", "制作海报")).toBe(true);
    expect(web).toHaveBeenLastCalledWith("miniQ · 任务未完成", {
      body: "「制作海报」执行未完成，请返回 miniQ 查看详情并继续任务。",
    });
  });

  it("only sends failures in failures mode and nothing in off mode", async () => {
    setTaskNotificationMode("failures");
    expect(await notifyTaskResult("completed", "任务")).toBe(false);
    expect(await notifyTaskResult("failed", "任务")).toBe(true);
    expect(web).toHaveBeenCalledTimes(1);
    setTaskNotificationMode("off");
    expect(await notifyTaskResult("failed", "任务")).toBe(false);
    expect(web).toHaveBeenCalledTimes(1);
  });

  it("does not notify while miniQ has focus", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(await notifyTaskResult("failed", "任务")).toBe(false);
    expect(web).not.toHaveBeenCalled();
  });

  it("does not notify while the embedded browser owns focus inside the native window", async () => {
    platform.native = true;
    isWindowFocused.mockResolvedValue(true);
    expect(await notifyTaskResult("completed", "任务")).toBe(false);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when the native window focus cannot be checked", async () => {
    platform.native = true;
    isWindowFocused.mockRejectedValue(new Error("window state unavailable"));
    expect(await notifyTaskResult("failed", "任务")).toBe(false);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    expect(web).not.toHaveBeenCalled();
  });

  it("never requests web permission from a task event", async () => {
    web.permission = "default";
    expect(await notifyTaskResult("completed", "任务")).toBe(false);
    expect(web.requestPermission).not.toHaveBeenCalled();
    expect(web).not.toHaveBeenCalled();
  });

  it("never requests native permission from a task event", async () => {
    platform.native = true;
    plugin.isPermissionGranted.mockResolvedValue(false);
    expect(await notifyTaskResult("failed", "任务")).toBe(false);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    expect(web).not.toHaveBeenCalled();
  });

  it("does not fall through to web delivery when native sending fails", async () => {
    platform.native = true;
    plugin.sendNotification.mockImplementation(() => { throw new Error("OS error"); });
    expect(await notifyTaskResult("failed", "任务")).toBe(false);
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    expect(web).not.toHaveBeenCalled();
    expect(web.requestPermission).not.toHaveBeenCalled();
  });

  it("rechecks focus after an asynchronous native permission lookup", async () => {
    platform.native = true;
    plugin.isPermissionGranted.mockImplementation(async () => {
      vi.mocked(document.hasFocus).mockReturnValue(true);
      return true;
    });
    expect(await notifyTaskResult("completed", "任务")).toBe(false);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("rechecks native window focus after an asynchronous permission lookup", async () => {
    platform.native = true;
    plugin.isPermissionGranted.mockImplementation(async () => {
      isWindowFocused.mockResolvedValue(true);
      return true;
    });
    expect(await notifyTaskResult("completed", "任务")).toBe(false);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("rechecks preferences after an asynchronous native permission lookup", async () => {
    platform.native = true;
    plugin.isPermissionGranted.mockImplementation(async () => {
      setTaskNotificationMode("off");
      return true;
    });
    expect(await notifyTaskResult("completed", "任务")).toBe(false);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});

describe("explicit notification controls", () => {
  it("requests web permission only through the explicit permission action", async () => {
    web.permission = "default";
    expect(await requestTaskNotificationPermission()).toBe("granted");
    expect(web.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("requests native permission without asking the web notification API", async () => {
    platform.native = true;
    plugin.isPermissionGranted.mockResolvedValue(false);
    expect(await requestTaskNotificationPermission()).toBe("granted");
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(web.requestPermission).not.toHaveBeenCalled();
  });

  it("allows a user-requested test in the foreground", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(await sendTaskNotificationTest()).toBe(true);
    expect(web).toHaveBeenCalledTimes(1);
    expect(web.requestPermission).not.toHaveBeenCalled();
  });

  it("allows a user-requested native test even if window focus is unavailable", async () => {
    platform.native = true;
    isWindowFocused.mockRejectedValue(new Error("window state unavailable"));
    expect(await sendTaskNotificationTest()).toBe(true);
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    expect(isWindowFocused).not.toHaveBeenCalled();
  });
});
