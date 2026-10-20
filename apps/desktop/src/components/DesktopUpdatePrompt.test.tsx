// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdatePrompt, desktopUpdateStamps, type DesktopUpdater } from "./DesktopUpdatePrompt";
import { desktopInstalledReleaseNotices } from "../installedReleaseNotice";
import { UPDATE_REMINDER_COOLDOWN_MS } from "../updatePolicy";
import type { AppUpdaterState } from "../hooks/useAppUpdater";

const version = vi.hoisted(() => ({ current: "0.1.159" }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => version.current }));

const IDLE: AppUpdaterState = { phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null, busyReason: null, releaseNotes: [] };
const available: AppUpdaterState = { ...IDLE, phase: "available", version: "0.1.160", releaseNotes: ["新增手机上传", "修复折叠记录加载"] };
const updater = (state: AppUpdaterState, extra: Partial<DesktopUpdater> = {}): DesktopUpdater => ({
  supported: true, state, checkNow: vi.fn().mockResolvedValue(undefined), install: vi.fn().mockResolvedValue(undefined), ...extra,
});
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  localStorage.clear(); desktopUpdateStamps.reset(); version.current = "0.1.159";
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("opens a dialog with the release notes as soon as an update is available", async () => {
  render(<DesktopUpdatePrompt updater={updater(available)} />); await flush();
  expect(screen.getByRole("dialog", { name: /发现新版本 v0\.1\.160/ })).toBeTruthy();
  expect(screen.getByText("新增手机上传")).toBeTruthy();
  expect(screen.getByText("修复折叠记录加载")).toBeTruthy();
});

it("installs only after the explicit action and does not install on dismiss", async () => {
  const value = updater(available);
  render(<DesktopUpdatePrompt updater={value} />); await flush();
  fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
  expect(value.install).toHaveBeenCalledOnce();
});

it("asks before stopping a running task instead of reporting an update error", async () => {
  const stopTaskAndInstall = vi.fn().mockResolvedValue(undefined);
  const deferTaskPrompt = vi.fn();
  const value = updater({ ...available, busyReason: "active-task" }, { stopTaskAndInstall, deferTaskPrompt });
  render(<DesktopUpdatePrompt updater={value} />); await flush();
  expect(screen.getByRole("status").textContent).toContain("当前有任务正在执行");
  expect(screen.getByRole("button", { name: "停止任务并更新" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "继续当前任务" }));
  await flush();
  expect(deferTaskPrompt).toHaveBeenCalledOnce();
  expect(stopTaskAndInstall).not.toHaveBeenCalled();
});

it("calls the explicit stop-and-update action for a busy session", async () => {
  const stopTaskAndInstall = vi.fn().mockResolvedValue(undefined);
  const value = updater({ ...available, busyReason: "active-task" }, { stopTaskAndInstall });
  render(<DesktopUpdatePrompt updater={value} />); await flush();
  fireEvent.click(screen.getByRole("button", { name: "停止任务并更新" }));
  expect(stopTaskAndInstall).toHaveBeenCalledOnce();
});

it("snoozes the same version for a day but announces a newer one", async () => {
  const first = render(<DesktopUpdatePrompt updater={updater(available)} />); await flush();
  fireEvent.click(screen.getByRole("button", { name: "稍后提醒" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  first.unmount();
  render(<DesktopUpdatePrompt updater={updater(available)} />); await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();
  render(<DesktopUpdatePrompt updater={updater({ ...available, version: "0.1.161" })} />); await flush();
  expect(screen.getByRole("dialog", { name: /发现新版本 v0\.1\.161/ })).toBeTruthy();
  expect(UPDATE_REMINDER_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
});

it("waits for an open modal instead of stacking on it", async () => {
  const other = document.createElement("dialog"); other.setAttribute("open", ""); document.body.append(other);
  render(<DesktopUpdatePrompt updater={updater(available)} />); await flush();
  expect(screen.queryByText(/发现新版本/)).toBeNull();
  await act(async () => { other.remove(); await Promise.resolve(); });
  expect(screen.getByRole("dialog", { name: /发现新版本/ })).toBeTruthy();
});

it("shows progress while downloading and an actionable error after a failure", async () => {
  const view = render(<DesktopUpdatePrompt updater={updater(available)} />); await flush();
  view.rerender(<DesktopUpdatePrompt updater={updater({ ...available, phase: "downloading", downloadedBytes: 30, totalBytes: 100 })} />);
  expect(screen.getByText("正在下载 30%")).toBeTruthy();
  expect((screen.getByRole("button", { name: "更新中…" }) as HTMLButtonElement).disabled).toBe(true);
  const check = vi.fn().mockResolvedValue(undefined);
  view.rerender(<DesktopUpdatePrompt updater={updater({ ...available, phase: "error", error: "任务执行中，请等待任务完成后更新。" }, { checkNow: check })} />);
  expect(screen.getByRole("alert").textContent).toContain("任务执行中");
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  expect(check).toHaveBeenCalledOnce();
});

it("announces what changed once after an upgrade, using notes cached before the update", async () => {
  desktopInstalledReleaseNotices.pending("0.1.159");
  desktopInstalledReleaseNotices.cache({ platform: "desktop", version: "0.1.160", releaseNotes: ["已安装版本说明"] });
  desktopInstalledReleaseNotices.cache({ platform: "desktop", version: "0.1.161", releaseNotes: ["未来说明"] });
  version.current = "0.1.160";
  const view = render(<DesktopUpdatePrompt updater={updater(IDLE)} />); await flush();
  expect(screen.getByRole("dialog", { name: /已更新至 0\.1\.160/ })).toBeTruthy();
  expect(screen.getByText("已安装版本说明")).toBeTruthy(); expect(screen.queryByText("未来说明")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "开始使用" })); view.unmount();
  render(<DesktopUpdatePrompt updater={updater(IDLE)} />); await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("stays silent on the first launch and on unsupported platforms", async () => {
  render(<DesktopUpdatePrompt updater={updater(IDLE)} />); await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();
  render(<DesktopUpdatePrompt updater={updater(available, { supported: false })} />); await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
});
