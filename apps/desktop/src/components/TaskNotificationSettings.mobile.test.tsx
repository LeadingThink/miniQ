// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const push = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    status: "needs_permission" as string,
    listeners,
    set(next: string) {
      this.status = next;
      for (const listener of listeners) listener();
    },
    refresh: vi.fn(),
    request: vi.fn(async () => true),
    checkPermissions: vi.fn(async () => ({ display: "prompt" })),
    requestPermissions: vi.fn(async () => ({ display: "granted" })),
  };
});

vi.mock("../runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => true }));
vi.mock("../appBadge", () => ({ markAppBadge: vi.fn(async () => null) }));
vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    checkPermissions: push.checkPermissions,
    requestPermissions: push.requestPermissions,
    createChannel: vi.fn(async () => undefined),
    schedule: vi.fn(async () => ({ notifications: [] })),
  },
}));
vi.mock("../remotePush", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useRemotePushStatus: () => useSyncExternalStore(
      (listener) => { push.listeners.add(listener); return () => push.listeners.delete(listener); },
      () => push.status,
    ),
    refreshRemotePush: push.refresh,
    requestRemotePushPermission: push.request,
  };
});
const bg = vi.hoisted(() => ({
  android: false,
  enabled: false,
  listeners: new Set<() => void>(),
  unrestricted: false,
  set: vi.fn(async (value: boolean) => {
    bg.enabled = value;
    for (const listener of bg.listeners) listener();
    return value;
  }),
  open: vi.fn(async () => true),
}));
vi.mock("../backgroundConnection", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    isBackgroundConnectionSupported: () => bg.android,
    isBatteryUnrestricted: async () => bg.unrestricted,
    openBatterySettings: bg.open,
    setBackgroundConnectionEnabled: bg.set,
    useBackgroundConnectionEnabled: () => useSyncExternalStore(
      (listener) => { bg.listeners.add(listener); return () => bg.listeners.delete(listener); },
      () => bg.enabled,
    ),
  };
});

import { getQuietHours } from "../quietHours";
import { TaskNotificationSettings } from "./TaskNotificationSettings";

beforeEach(() => {
  localStorage.clear();
  push.status = "needs_permission";
  push.request.mockResolvedValue(true);
  bg.android = false;
  bg.enabled = false;
  bg.unrestricted = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it("explains each offline push status in plain Chinese", async () => {
  render(<TaskNotificationSettings />);
  expect(screen.getByText(/离线推送未开启：需要允许 miniQ 发送通知/)).toBeTruthy();
  act(() => push.set("active"));
  expect(screen.getByText(/离线推送已开启/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "允许通知" })).toBeNull();
  act(() => push.set("server_disabled"));
  expect(screen.getByText(/中转服务器未配置推送服务/)).toBeTruthy();
  act(() => push.set("denied"));
  expect(screen.getByText(/设置 › 通知 › miniQ/)).toBeTruthy();
  act(() => push.set("error"));
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(push.refresh).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole("button", { name: "启用系统通知" })).toBeTruthy());
});

it("requests push permission only from the explicit allow tap", async () => {
  render(<TaskNotificationSettings />);
  expect(push.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "允许通知" }));
  await waitFor(() => expect(push.request).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("status")).toBeNull();
});

it("tells the user where to grant permission when the request is refused", async () => {
  push.request.mockResolvedValue(false);
  render(<TaskNotificationSettings />);
  fireEvent.click(screen.getByRole("button", { name: "允许通知" }));
  expect(await screen.findByText(/请在手机系统设置中允许 miniQ 发送通知/)).toBeTruthy();
});

it("re-registers offline push after enabling system notifications", async () => {
  render(<TaskNotificationSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "启用系统通知" }));
  await waitFor(() => expect(push.requestPermissions).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(push.refresh).toHaveBeenCalled());
});

it("hides push and quiet hours when notifications are off", () => {
  render(<TaskNotificationSettings />);
  fireEvent.change(screen.getByRole("combobox", { name: "通知方式" }), { target: { value: "off" } });
  expect(screen.queryByText("离线推送")).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /免打扰时段/ })).toBeNull();
});

it("turns quiet hours on with a default window and saves edits", () => {
  render(<TaskNotificationSettings />);
  const toggle = screen.getByRole("checkbox", { name: /免打扰时段/ }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(screen.queryByLabelText("开始")).toBeNull();

  fireEvent.click(toggle);
  expect(getQuietHours()).toMatchObject({ start: "23:00", end: "08:00" });
  expect(screen.getByText("每天 23:00 至次日 08:00")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("开始"), { target: { value: "22:30" } });
  expect(getQuietHours()).toMatchObject({ start: "22:30", end: "08:00" });
  fireEvent.change(screen.getByLabelText("结束"), { target: { value: "" } });
  expect(getQuietHours()).toMatchObject({ start: "22:30", end: "08:00" });
  fireEvent.change(screen.getByLabelText("结束"), { target: { value: "22:30" } });
  expect(screen.getByText(/全天免打扰/)).toBeTruthy();

  fireEvent.click(screen.getByRole("checkbox", { name: /免打扰时段/ }));
  expect(getQuietHours()).toBeNull();
  expect(screen.queryByLabelText("开始")).toBeNull();
});

it("reports a quiet hours save failure", async () => {
  render(<TaskNotificationSettings />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  fireEvent.click(screen.getByRole("checkbox", { name: /免打扰时段/ }));
  expect(await screen.findByText("无法保存免打扰时段，请检查本机存储是否可用。")).toBeTruthy();
  expect(getQuietHours()).toBeNull();
});

it("offers Android background connection instead of an unsupported push row", async () => {
  bg.android = true;
  push.status = "unsupported";
  render(<TaskNotificationSettings />);
  expect(screen.queryByText("离线推送")).toBeNull();
  const toggle = screen.getByRole("checkbox", { name: /后台保持连接/ }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);

  fireEvent.click(toggle);
  await waitFor(() => expect(bg.set).toHaveBeenCalledWith(true));
  expect(((await screen.findByRole("checkbox", { name: /后台保持连接/ })) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "去设置" }));
  await waitFor(() => expect(bg.open).toHaveBeenCalledTimes(1));
});

it("does not show background connection on iOS", () => {
  render(<TaskNotificationSettings />);
  expect(screen.queryByRole("checkbox", { name: /后台保持连接/ })).toBeNull();
});
