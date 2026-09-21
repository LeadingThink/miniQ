// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTaskNotificationMode } from "../taskNotifications";
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
