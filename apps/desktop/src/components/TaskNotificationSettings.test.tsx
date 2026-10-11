// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTaskNotificationMode } from "../taskNotifications";
import * as taskNotifications from "../taskNotifications";
import { TaskNotificationSettings } from "./TaskNotificationSettings";

vi.mock("../runtime", () => ({ isTauriRuntime: () => false }));
const web = Object.assign(vi.fn(function () {}), {
  permission: "default" as NotificationPermission,
  requestPermission: vi.fn(),
});
beforeEach(() => {
  localStorage.clear();
  web.mockClear();
  web.permission = "default";
  web.requestPermission.mockReset().mockImplementation(async () => {
    web.permission = "granted";
    return "granted";
  });
  vi.stubGlobal("Notification", web);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("persists modes without requesting permission on mount or mode changes", async () => {
  const { unmount } = render(<TaskNotificationSettings />);
  fireEvent.change(screen.getByRole("combobox", { name: "通知方式" }), { target: { value: "failures" } });
  expect(getTaskNotificationMode()).toBe("failures");
  await waitFor(() => expect(screen.getByRole("button", { name: "启用系统通知" })).toBeTruthy());
  expect(web.requestPermission).not.toHaveBeenCalled();
  unmount();
  render(<TaskNotificationSettings />);
  expect((screen.getByRole("combobox", { name: "通知方式" }) as HTMLSelectElement).value).toBe("failures");
  fireEvent.change(screen.getByRole("combobox", { name: "通知方式" }), { target: { value: "off" } });
  expect(screen.queryByRole("button", { name: "启用系统通知" })).toBeNull();
});

it("keeps mobile-only push settings off the desktop while exposing desktop sound quiet hours", () => {
  render(<TaskNotificationSettings />);
  expect(screen.queryByText("离线推送")).toBeNull();
  expect(screen.getByRole("checkbox", { name: /免打扰时段/ })).toBeTruthy();
});

it("requests permission and sends one test after the explicit enable click", async () => {
  render(<TaskNotificationSettings />);
  fireEvent.click(screen.getByRole("button", { name: "启用系统通知" }));
  expect(await screen.findByText("测试通知已发送，请在系统通知中查看。")).toBeTruthy();
  expect(web.requestPermission).toHaveBeenCalledTimes(1);
  expect(web).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "发送测试通知" })).toBeTruthy();
});

it("explains denied permission without leaking errors or repeatedly requesting", async () => {
  web.requestPermission.mockResolvedValue("denied");
  render(<TaskNotificationSettings />);
  fireEvent.click(screen.getByRole("button", { name: "启用系统通知" }));
  expect(await screen.findByText(/通知权限未开启/)).toBeTruthy();
  expect(web.requestPermission).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("combobox", { name: "通知方式" }), { target: { value: "failures" } });
  expect(web.requestPermission).toHaveBeenCalledTimes(1);
  expect(web).not.toHaveBeenCalled();
});

it("shows a save failure instead of pretending the preference was retained", async () => {
  render(<TaskNotificationSettings />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
  fireEvent.change(screen.getByRole("combobox", { name: "通知方式" }), { target: { value: "off" } });
  expect(await screen.findByText("无法保存通知设置，请检查本机存储是否可用。")).toBeTruthy();
  expect(getTaskNotificationMode()).toBe("all");
});

it("toggles approval and question reminders independently and persists them", () => {
  const { unmount } = render(<TaskNotificationSettings />);
  const approval = screen.getByRole("switch", { name: "需要审批时提醒" });
  const question = screen.getByRole("switch", { name: "需要我回答时提醒" });
  expect(approval.getAttribute("aria-checked")).toBe("true");
  expect(question.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(approval);
  expect(screen.getByRole("switch", { name: "需要审批时提醒" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("switch", { name: "需要我回答时提醒" }).getAttribute("aria-checked")).toBe("true");
  expect(web.requestPermission).not.toHaveBeenCalled();
  unmount();
  render(<TaskNotificationSettings />);
  expect(screen.getByRole("switch", { name: "需要审批时提醒" }).getAttribute("aria-checked")).toBe("false");
});

it("splits desktop sound settings into their own section with per-kind previews", () => {
  const preview = vi.spyOn(taskNotifications, "playTaskSound").mockResolvedValue(true);
  render(<TaskNotificationSettings />);
  const sounds = screen.getByRole("region", { name: "提醒音效" });
  expect(screen.getByRole("region", { name: "任务通知" }).contains(sounds)).toBe(false);
  expect(within(sounds).getByRole("switch", { name: "提醒音效" }).getAttribute("aria-checked")).toBe("true");
  for (const label of ["完成", "失败", "需要处理"]) expect(within(sounds).getByRole("switch", { name: `${label}提示音` })).toBeTruthy();
  expect(within(sounds).getByRole("switch", { name: "仅在 miniQ 不在前台时播放" })).toBeTruthy();
  expect(within(sounds).getByRole("slider", { name: "音量" })).toBeTruthy();
  expect(within(sounds).getByText("55%")).toBeTruthy();
  expect(within(sounds).getByRole("checkbox", { name: /免打扰时段/ })).toBeTruthy();
  expect(preview).not.toHaveBeenCalled();
  fireEvent.click(within(sounds).getByRole("button", { name: "试听失败提示音" }));
  expect(preview).toHaveBeenCalledExactlyOnceWith("failed", { userInitiated: true, ignoreSettings: true });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("hides sound details when the master switch is off", () => {
  render(<TaskNotificationSettings />);
  fireEvent.click(screen.getByRole("switch", { name: "提醒音效" }));
  expect(screen.getByRole("switch", { name: "提醒音效" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByRole("slider", { name: "音量" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "完成提示音" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /免打扰时段/ })).toBeNull();
});

it("reports a failed preview", async () => {
  vi.spyOn(taskNotifications, "playTaskSound").mockResolvedValue(false);
  render(<TaskNotificationSettings />);
  fireEvent.click(screen.getByRole("button", { name: "试听完成提示音" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/音效暂不可用/);
});
