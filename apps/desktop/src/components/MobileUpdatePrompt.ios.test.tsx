// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileUpdatePrompt } from "./MobileUpdatePrompt";
import { iosInstalledReleaseNotices } from "../iosInstalledReleaseNotice";
import { IOS_APP_STORE_URL } from "../mobileUpdate";
const mocks = vi.hoisted(() => ({ version: "1.0", platform: "ios", run: vi.fn(), canPrompt: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => mocks.platform } }));
vi.mock("@capacitor/app", () => ({ App: { getInfo: async () => ({ version: mocks.version }), addListener: async () => ({ remove() {} }) } }));
vi.mock("../mobileUpdate", async (importOriginal) => ({ ...await importOriginal<typeof import("../mobileUpdate")>(), readInstalledVersion: async () => mocks.version }));
vi.mock("../mobileUpdateScheduler", () => ({ mobileUpdateScheduler: { run: mocks.run, canPrompt: mocks.canPrompt, defer: vi.fn() } }));
vi.mock("../mobileUpdateLinks", () => ({ openMobileUpdateUrl: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); mocks.version = "1.0"; mocks.platform = "ios";
  localStorage.setItem("miniq:ios-installed-release:baseline", "1.0");
  mocks.run.mockResolvedValue({ phase: "idle" }); mocks.canPrompt.mockReturnValue(true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const flush = async () => { await act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(0); }); };
it("shows installed notes once under StrictMode, never the future version notes", async () => {
  iosInstalledReleaseNotices.cache({ platform: "ios", version: "1.1", releaseNotes: ["已安装说明"] });
  iosInstalledReleaseNotices.cache({ platform: "ios", version: "1.2", releaseNotes: ["未来说明"] });
  mocks.version = "1.1";
  const view = render(<StrictMode><MobileUpdatePrompt /></StrictMode>); await flush();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByText("已安装说明")).toBeTruthy(); expect(screen.queryByText("未来说明")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "开始使用" })); view.unmount();
  render(<MobileUpdatePrompt />); await flush(); expect(screen.queryByRole("dialog")).toBeNull();
});
it("waits for an existing dialog without consuming the notice and survives remount", async () => {
  mocks.version = "1.3";
  const other = document.createElement("dialog"); other.setAttribute("open", ""); document.body.append(other);
  const view = render(<MobileUpdatePrompt />); await flush();
  expect(screen.queryByText("已更新至 1.3")).toBeNull(); view.unmount();
  render(<MobileUpdatePrompt />); await flush();
  await act(async () => { other.remove(); });
  expect(screen.getByText("已更新至 1.3")).toBeTruthy();
  expect(screen.getByText("你已安装此版本。暂未获取到此版本的详细更新说明。")).toBeTruthy();
});
it("serializes installed and available-release dialogs across concurrent mounts", async () => {
  mocks.version = "1.1";
  mocks.run.mockResolvedValue({ phase: "available", release: { platform: "ios", version: "1.2", url: IOS_APP_STORE_URL, installationNotes: [] } });
  render(<><MobileUpdatePrompt /><MobileUpdatePrompt /></>); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(screen.getByText("已更新至 1.1")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "开始使用" })); });
  expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(screen.getByText("发现新版本 1.2")).toBeTruthy();
});
it("never shows installed release notices on Android", async () => {
  mocks.platform = "android"; mocks.version = "1.1";
  render(<MobileUpdatePrompt />); await flush(); expect(screen.queryByRole("dialog")).toBeNull();
});
