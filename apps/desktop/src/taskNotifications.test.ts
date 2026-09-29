// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAttentionNotificationPrefs,
  getTaskNotificationMode,
  notifyAttention,
  setAttentionNotificationPref,
  isAppInBackground,
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
  it("reports background only when both the document and native window are unfocused", async () => {
    expect(await isAppInBackground()).toBe(true);
    platform.native = true;
    expect(await isAppInBackground()).toBe(true);
    isWindowFocused.mockResolvedValue(true);
    expect(await isAppInBackground()).toBe(false);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(await isAppInBackground()).toBe(false);
  });

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

describe("attention notifications", () => {
  it("defaults both reminders on and persists each toggle independently", () => {
    expect(getAttentionNotificationPrefs()).toEqual({ approval: true, question: true });
    setAttentionNotificationPref("approval", false);
    expect(getAttentionNotificationPrefs()).toEqual({ approval: false, question: true });
    setAttentionNotificationPref("question", false);
    setAttentionNotificationPref("approval", true);
    expect(getAttentionNotificationPrefs()).toEqual({ approval: true, question: false });
    expect(getAttentionNotificationPrefs()).toBe(getAttentionNotificationPrefs());
  });

  it("falls back to defaults for corrupt stored values", () => {
    localStorage.setItem("miniq.attentionNotifications.v1", "{not json");
    expect(getAttentionNotificationPrefs()).toEqual({ approval: true, question: true });
    localStorage.setItem("miniq.attentionNotifications.v1", JSON.stringify({ approval: "no" }));
    expect(getAttentionNotificationPrefs()).toEqual({ approval: true, question: true });
  });

  it("titles approval and question reminders with the session name", async () => {
    expect(await notifyAttention("approval", "修复构建", "运行 npm install")).toBe(true);
    expect(web).toHaveBeenLastCalledWith("需要你审批：修复构建", { body: "运行 npm install" });
    expect(await notifyAttention("question", "", "  ")).toBe(true);
    expect(web).toHaveBeenLastCalledWith("需要你回答：当前会话", { body: "助手在等待你的回答，请返回 miniQ 处理。" });
  });

  it("respects each toggle and window focus", async () => {
    setAttentionNotificationPref("approval", false);
    expect(await notifyAttention("approval", "a", "b")).toBe(false);
    expect(await notifyAttention("question", "a", "b")).toBe(true);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(await notifyAttention("question", "a", "b")).toBe(false);
    expect(web).toHaveBeenCalledTimes(1);
  });

  it("is independent of the task notification mode and never requests permission", async () => {
    setTaskNotificationMode("off");
    web.permission = "default";
    expect(await notifyAttention("approval", "a", "b")).toBe(false);
    expect(web.requestPermission).not.toHaveBeenCalled();
    web.permission = "granted";
    expect(await notifyAttention("approval", "a", "b")).toBe(true);
  });

  it("runs the click handler for web notifications", async () => {
    const onClick = vi.fn();
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    await notifyAttention("approval", "a", "b", onClick);
    const instance = web.mock.instances[0] as unknown as { onclick: () => void; close: () => void };
    instance.close = vi.fn();
    instance.onclick();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(instance.close).toHaveBeenCalled();
  });

  it("delivers natively on desktop", async () => {
    platform.native = true;
    expect(await notifyAttention("question", "会话", "问题")).toBe(true);
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "需要你回答：会话", body: "问题" });
    expect(web).not.toHaveBeenCalled();
  });
});
