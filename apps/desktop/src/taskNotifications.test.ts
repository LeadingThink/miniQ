// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAttentionNotificationPrefs,
  getTaskSoundSettings,
  getTaskNotificationMode,
  notifyAttention,
  setAttentionNotificationPref,
  isAppInBackground,
  notifyTaskResult,
  requestTaskNotificationPermission,
  sendTaskNotificationTest,
  setTaskSoundSettings,
  setTaskNotificationMode,
} from "./taskNotifications";
import { setQuietHours } from "./quietHours";

const platform = vi.hoisted(() => ({ native: false }));
const isWindowFocused = vi.hoisted(() => vi.fn());
const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("./runtime", () => ({ isTauriRuntime: () => platform.native }));
vi.mock("@tauri-apps/plugin-notification", () => plugin);
const web = Object.assign(vi.fn(function () {}), {
  permission: "granted" as NotificationPermission,
  requestPermission: vi.fn(),
});
const originalAudioContext = typeof window === "undefined" ? undefined : window.AudioContext;

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
  vi.stubGlobal("__TAURI_INTERNALS__", { metadata: { currentWindow: { label: "main" } }, invoke: isWindowFocused });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof window !== "undefined") Object.defineProperty(window, "AudioContext", { configurable: true, value: originalAudioContext });
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

  it("shows an in-app result while miniQ has focus", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(await notifyTaskResult("failed", "任务")).toBe(true);
    expect(web).not.toHaveBeenCalled();
  });

  it("shows an in-app result while the embedded browser owns focus inside the native window", async () => {
    platform.native = true;
    isWindowFocused.mockResolvedValue(true);
    expect(await notifyTaskResult("completed", "任务")).toBe(true);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("falls back when the native window focus cannot be checked", async () => {
    platform.native = true;
    isWindowFocused.mockRejectedValue(new Error("window state unavailable"));
    expect(await notifyTaskResult("failed", "任务")).toBe(true);
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
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

describe("desktop task sounds", () => {
  it("uses the defaults, clamps volume, respects quiet hours and background settings, and deduplicates each event kind", async () => {
    const oscillators: Array<{ connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    const context = {
      state: "running",
      currentTime: 0,
      destination: {},
      resume: vi.fn(async () => undefined),
      createGain: vi.fn(() => ({
        gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      })),
      createOscillator: vi.fn(() => {
        const oscillator = { frequency: { value: 0, setValueAtTime: vi.fn() }, type: "sine", connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
        oscillators.push(oscillator);
        return oscillator;
      }),
    };
    const AudioContextMock = vi.fn(function AudioContextMock() { return context; });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: AudioContextMock });
    document.dispatchEvent(new Event("pointerdown"));

    expect(getTaskSoundSettings()).toEqual({
      enabled: true,
      completed: true,
      failed: true,
      attention: true,
      backgroundOnly: false,
      volume: 0.55,
    });
    setTaskSoundSettings({ volume: -1 });
    expect(getTaskSoundSettings().volume).toBe(0);
    setTaskSoundSettings({ volume: 2 });
    expect(getTaskSoundSettings().volume).toBe(1);
    setTaskSoundSettings({ volume: 0.55 });

    setQuietHours({ start: "00:00", end: "00:00" });
    expect(await notifyTaskResult("completed", "quiet-sound")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oscillators).toHaveLength(0);
    setQuietHours(null);

    expect(await notifyTaskResult("completed", "one-sound")).toBe(true);
    expect(await notifyTaskResult("completed", "one-sound")).toBe(true);
    expect(await notifyTaskResult("failed", "one-sound")).toBe(true);
    expect(await notifyAttention("approval", "one-sound", "需要处理")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oscillators).toHaveLength(7);

    setTaskSoundSettings({ backgroundOnly: true });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(await notifyTaskResult("failed", "foreground-sound")).toBe(true);
    expect(oscillators).toHaveLength(7);
  });

  it("does not let a blocked AudioContext change the notification result", async () => {
    const broken = { state: "running", currentTime: 0, destination: {}, resume: vi.fn(async () => undefined), createGain: vi.fn(), createOscillator: vi.fn(() => { throw new Error("blocked"); }) };
    const AudioContextMock = vi.fn(function AudioContextMock() { return broken; });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: AudioContextMock });
    document.dispatchEvent(new Event("keydown"));
    expect(await notifyTaskResult("failed", "audio-failure")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(web).toHaveBeenCalledTimes(1);
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
    expect(await notifyAttention("question", "a", "b")).toBe(true);
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
