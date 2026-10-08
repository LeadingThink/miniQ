// @vitest-environment jsdom
import { IOS_APP_STORE_URL } from "../mobileUpdate";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileUpdateDialog, MobileUpdatePrompt } from "./MobileUpdatePrompt";
const { supported, run, defer, open, listen, remove, canPrompt } = vi.hoisted(() => ({ canPrompt: vi.fn(), supported: vi.fn(), run: vi.fn(), defer: vi.fn(), open: vi.fn(), listen: vi.fn(), remove: vi.fn() }));
vi.mock("../mobileUpdate", async (original) => ({ ...await original<typeof import("../mobileUpdate")>(), isMobileUpdateSupported: supported }));
vi.mock("../mobileUpdateScheduler", () => ({ mobileUpdateScheduler: { run, defer, canPrompt } }));
vi.mock("../mobileUpdateLinks", () => ({ openMobileUpdateUrl: open }));
vi.mock("@capacitor/app", () => ({ App: { addListener: listen } }));
const release = { version: "0.1.48", url: "https://oss.zaiwen.top/releases/miniq/android/v0.1.48/miniQ.apk", installationNotes: ["保留原有设置"] };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  canPrompt.mockReturnValue(true); supported.mockReturnValue(true); run.mockResolvedValue({ phase: "available", release }); open.mockResolvedValue(undefined);
  listen.mockResolvedValue({ remove });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const start = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); };
it("never registers or checks on unsupported platforms", async () => {
  supported.mockReturnValue(false); render(<MobileUpdatePrompt />); await start();
  expect(listen).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});
it("checks once under StrictMode and does not duplicate a visible prompt on resume", async () => {
  render(<StrictMode><MobileUpdatePrompt /></StrictMode>); await start();
  expect(run).toHaveBeenCalledTimes(1); expect(screen.getAllByRole("dialog")).toHaveLength(1);
  await act(async () => { listen.mock.calls.at(-1)![1]({ isActive: true }); });
  expect(run).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "稍后提醒" })); expect(screen.queryByRole("dialog")).toBeNull();
  expect(defer).toHaveBeenCalledWith(release.version);
});
it("waits for existing modal before showing and cleans up listeners", async () => {
  const other = document.createElement("dialog"); other.setAttribute("open", ""); document.body.append(other);
  const view = render(<MobileUpdatePrompt />); await start();
  expect(screen.queryByText(/发现新版本/)).toBeNull();
  await act(async () => { other.remove(); }); expect(screen.getByRole("dialog", { name: /发现新版本/ })).toBeTruthy();
  view.unmount(); await act(async () => {}); expect(remove).toHaveBeenCalledOnce();
});
it("contains automatic error without UI and checks again on foreground", async () => {
  run.mockResolvedValue({ phase: "error", error: "offline" }); render(<MobileUpdatePrompt />); await start();
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { listen.mock.calls[0][1]({ isActive: true }); }); expect(run).toHaveBeenCalledTimes(2);
});
it("opens the official APK only after the explicit update action", async () => {
  const close = vi.fn(); render(<MobileUpdateDialog release={release} onClose={close} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "稍后提醒" })); expect(open).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "立即更新" })); });
  expect(open).toHaveBeenCalledWith(release.url); expect(close).toHaveBeenCalledOnce();
});
it("keeps dialog open with accessible error when browser opening fails", async () => {
  open.mockRejectedValue(new Error("blocked")); const close = vi.fn(); render(<MobileUpdateDialog release={release} onClose={close} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "立即更新" })); });
  expect(screen.getByRole("alert").textContent).toContain("无法打开"); expect(close).not.toHaveBeenCalled();
});
it("revalidates URL immediately before opening", async () => {
  render(<MobileUpdateDialog release={{ ...release, url: "https://evil.example/app.apk" }} onClose={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "立即更新" })); });
  expect(open).not.toHaveBeenCalled(); expect(screen.getByRole("alert")).toBeTruthy();
});
it("treats native dialog cancellation as later and restores focus", () => {
  const previous = document.createElement("button"); document.body.append(previous); previous.focus();
  const close = vi.fn(); const view = render(<MobileUpdateDialog release={release} onClose={close} />);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(close).toHaveBeenCalledOnce(); expect(defer).toHaveBeenCalledWith(release.version);
  view.unmount(); expect(document.activeElement).toBe(previous); previous.remove();
});
it("holds a completed request while backgrounded, then presents it on foreground", async () => {
  let done!: (value: unknown) => void;
  run.mockImplementation(() => new Promise((resolve) => { done = resolve; }));
  render(<MobileUpdatePrompt />); await start();
  await act(async () => { listen.mock.calls[0][1]({ isActive: false }); done({ phase: "available", release }); });
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { listen.mock.calls[0][1]({ isActive: true }); });
  expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(run).toHaveBeenCalledTimes(1);
});
it("does not present an in-flight result after unmount", async () => {
  let done!: (value: unknown) => void;
  run.mockImplementation(() => new Promise((resolve) => { done = resolve; }));
  const view = render(<MobileUpdatePrompt />); await start(); view.unmount();
  await act(async () => { done({ phase: "available", release }); });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(defer).not.toHaveBeenCalled();
});

it("drops a deferred prompt if settings already presented that release", async () => {
  const other = document.createElement("dialog"); other.setAttribute("open", ""); document.body.append(other);
  render(<MobileUpdatePrompt />); await start(); canPrompt.mockReturnValue(false);
  await act(async () => { other.remove(); }); expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows release notes separately from installation instructions", () => {
  render(<MobileUpdateDialog release={{ ...release, releaseNotes: ["增加更新说明展示", "改进移动端体验"] }} onClose={vi.fn()} />);
  expect(screen.getByText("增加更新说明展示")).toBeTruthy(); expect(screen.getByText("改进移动端体验")).toBeTruthy();
  expect(screen.getByText("保留原有设置")).toBeTruthy(); expect(screen.queryByText("新版本已发布，欢迎更新体验。")).toBeNull();
});
it.each([undefined, []])("shows a factual fallback when release notes are absent or empty", (releaseNotes) => {
  render(<MobileUpdateDialog release={{ ...release, releaseNotes }} onClose={vi.fn()} />);
  expect(screen.getByText("新版本已发布，欢迎更新体验。")).toBeTruthy();
});

it("offers App Store navigation for iOS and never describes APK installation", async () => {
  const close = vi.fn();
  render(<MobileUpdateDialog release={{ ...release, platform: "ios", url: IOS_APP_STORE_URL, installationNotes: [] }} onClose={close} />);
  expect(screen.getByRole("button", { name: "稍后提醒" })).toBeTruthy();
  expect(screen.queryByText(/官方 APK/)).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "前往 App Store" })); });
  expect(open).toHaveBeenCalledWith(IOS_APP_STORE_URL);
  expect(close).toHaveBeenCalledOnce();
});
