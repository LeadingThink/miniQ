// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mobileUpdateScheduler } from "../mobileUpdateScheduler";
import { MobileUpdateCheck } from "./MobileUpdateCheck";
import { iosInstalledReleaseNotices } from "../iosInstalledReleaseNotice";
import { Capacitor } from "@capacitor/core";
import { IOS_APP_STORE_URL, MOBILE_DOWNLOAD_PAGE_URL } from "../mobileUpdate";

const { nativeGet, openExternalUrl } = vi.hoisted(() => ({ nativeGet: vi.fn(), openExternalUrl: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
  CapacitorHttp: { get: nativeGet },
}));
vi.mock("@capacitor/app", () => ({ App: { getInfo: async () => ({ version: "0.1.22" }) } }));
vi.mock("../mobileUpdateLinks", () => ({ openMobileUpdateUrl: openExternalUrl }));

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("offers a working download-page recovery action and allows another update check after a failure", async () => {
  nativeGet.mockRejectedValueOnce(new Error("Failed to fetch"));
  const apkUrl = "https://oss.zaiwen.top/releases/miniq/android/v0.1.23/miniQ_0.1.23_android.apk";
  nativeGet.mockResolvedValueOnce({
    status: 200, data: { products: { miniq: { platforms: { android: {
      version: "0.1.23", status: "available", url: apkUrl, fileSize: 2 * 1024 * 1024,
      installationNotes: ["安装后保留设置。"],
    } } } } },
  });
  render(<MobileUpdateCheck />);
  await screen.findByText("当前版本 0.1.22");
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("无法连接更新服务");
  expect(error.textContent).not.toContain("Failed to fetch");
  fireEvent.click(screen.getByRole("button", { name: "前往下载页" }));
  expect(openExternalUrl).toHaveBeenCalledWith(MOBILE_DOWNLOAD_PAGE_URL);
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  await screen.findByText("发现新版本 0.1.23（2.0 MB）");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "前往下载页" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中下载" }));
  expect(openExternalUrl).toHaveBeenCalledWith(apkUrl);
  expect(nativeGet).toHaveBeenCalledTimes(2);
});

it("shows the current-version result after a successful native request", async () => {
  nativeGet.mockResolvedValue({
    status: 200, data: { products: { miniq: { platforms: { android: {
      version: "0.1.22", status: "available", url: "https://oss.zaiwen.top/releases/miniq/android/v0.1.22/miniQ.apk",
    } } } } },
  });
  render(<MobileUpdateCheck />);
  await screen.findByText("当前版本 0.1.22");
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  await screen.findByText("已是最新版本");
  expect(screen.queryByRole("button", { name: "在浏览器中下载" })).toBeNull();
});

it("reports download opening failure and allows checking again", async () => {
  nativeGet.mockResolvedValue({ status: 200, data: { products: { miniq: { platforms: { android: {
    version: "0.1.23", status: "available", url: "https://oss.zaiwen.top/releases/miniq/android/v0.1.23/miniQ.apk",
  } } } } } });
  openExternalUrl.mockRejectedValue(new Error("browser unavailable"));
  render(<MobileUpdateCheck />); await screen.findByText("当前版本 0.1.22");
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "在浏览器中下载" }));
  expect((await screen.findByRole("alert")).textContent).toContain("无法打开下载链接");
  expect(screen.getByRole("button", { name: "检查更新" }).hasAttribute("disabled")).toBe(false);
});

it("uses the same settings entry to open App Store on iOS", async () => {
  vi.spyOn(Capacitor, "getPlatform").mockReturnValue("ios");
  const cache = vi.spyOn(iosInstalledReleaseNotices, "cache");
  vi.spyOn(mobileUpdateScheduler, "run").mockResolvedValue({ phase: "available", release: { platform: "ios", version: "0.2.4", url: IOS_APP_STORE_URL, releaseNotes: ["iOS说明"], installationNotes: [] } });
  render(<MobileUpdateCheck />);
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  await screen.findByText("发现新版本 0.2.4");
  fireEvent.click(await screen.findByRole("button", { name: "前往 App Store" }));
  await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(IOS_APP_STORE_URL));
  expect(cache).toHaveBeenCalledWith(expect.objectContaining({ platform: "ios", version: "0.2.4" }));
});
