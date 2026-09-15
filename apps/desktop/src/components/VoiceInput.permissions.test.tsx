// @vitest-environment jsdom
import { Capacitor } from "@capacitor/core";
import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import { startVoiceCapture, type VoiceCapture } from "../voiceCapture";
import { VoiceInput } from "./VoiceInput";

vi.mock("../voiceCapture", () => ({ startVoiceCapture: vi.fn() }));
vi.mock("../runtime", () => ({ isTauriRuntime: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: vi.fn(), getPlatform: vi.fn() } }));

beforeEach(() => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  vi.mocked(startVoiceCapture).mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
  vi.mocked(invoke).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

function setup() {
  const call = vi.fn();
  // Even when connected to another desktop, capture and settings belong to this device.
  const props = { client: { call, mode: "remote" } as unknown as RpcClient,
    onStart: vi.fn(), onPreview: vi.fn(), onTranscribed: vi.fn(), onError: vi.fn() };
  const view = render(<VoiceInput {...props} />);
  const trigger = screen.getByRole("button", { name: "语音输入" });
  trigger.focus(); fireEvent.click(trigger);
  return { props, call, view, trigger };
}

it.each(["NotAllowedError", "SecurityError"])("guides %s in a modal and cleans up the denied recording", async (name) => {
  vi.mocked(startVoiceCapture).mockRejectedValue(new DOMException("denied", name));
  const { props, call } = setup();
  await screen.findByRole("dialog", { name: "允许使用麦克风" });
  expect(screen.getByText(/系统设置 → 隐私与安全性 → 麦克风/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "打开系统设置" }));
  expect(props.onError).not.toHaveBeenCalled();
  expect(props.onPreview).toHaveBeenLastCalledWith(null);
  expect(vi.mocked(startVoiceCapture).mock.calls[0][0].aborted).toBe(true);
  expect(call).not.toHaveBeenCalled();
});

it("opens local settings, then records only when the user explicitly retries", async () => {
  const { call } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "打开系统设置" }));
  await screen.findByRole("status");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("open_microphone_settings");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "已开启，重试" }));
  fireEvent.focus(window); fireEvent(document, new Event("visibilitychange"));
  expect(startVoiceCapture).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "结束录音" })).toBeNull();
  vi.mocked(startVoiceCapture).mockResolvedValue({ stop: vi.fn() });
  fireEvent.click(screen.getByRole("button", { name: "已开启，重试" }));
  // Capture starts in the click gesture; Safari must not have to wait for an effect.
  expect(startVoiceCapture).toHaveBeenCalledTimes(2);
  await screen.findByRole("button", { name: "结束录音" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(call).not.toHaveBeenCalled();
});

it("keeps manual instructions and allows another attempt when launching settings fails", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("system opener failed"));
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "打开系统设置" }));
  expect((await screen.findByRole("alert")).textContent).toContain("请按上方路径手动开启权限");
  fireEvent.click(screen.getByRole("button", { name: "打开系统设置" }));
  await screen.findByRole("status");
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["暂不使用", "关闭麦克风权限提示", "Escape"])("dismisses via %s without retrying and restores focus", async (action) => {
  const { trigger, props } = setup();
  const dialog = await screen.findByRole("dialog");
  if (action === "Escape") fireEvent(dialog, new Event("cancel", { cancelable: true }));
  else fireEvent.click(screen.getByRole("button", { name: action }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(startVoiceCapture).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  expect(props.onTranscribed).not.toHaveBeenCalled();
});

it("shows the Windows desktop microphone settings path", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  setup();
  await screen.findByRole("dialog");
  expect(screen.getByText(/允许桌面应用访问麦克风/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "打开系统设置" })).toBeTruthy();
});

it("guides browser permission changes without offering remote system settings", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(false);
  setup();
  await screen.findByRole("dialog");
  expect(screen.getByText(/当前浏览器的网站设置/)).toBeTruthy();
  expect(screen.getByText(/无需修改远端电脑的权限/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "打开系统设置" })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it.each(["ios", "android"])("guides the native %s app to its own permission settings", async (platform) => {
  vi.mocked(isTauriRuntime).mockReturnValue(false);
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(Capacitor.getPlatform).mockReturnValue(platform);
  setup();
  await screen.findByRole("dialog");
  expect(screen.getByText(platform === "ios" ? /设置 → 隐私与安全性 → 麦克风/ : /设置 → 应用 → miniQ → 权限 → 麦克风/)).toBeTruthy();
  expect(screen.queryByText(/当前浏览器的网站设置/)).toBeNull();
});

it("keeps the guide available if permission is still denied after retrying", async () => {
  const { props } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "已开启，重试" }));
  await screen.findByRole("dialog");
  expect(startVoiceCapture).toHaveBeenCalledTimes(2);
  expect(props.onError).not.toHaveBeenCalled();
});

it("does not surface a late denial after switching away from the owning session", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(startVoiceCapture).mockImplementation(() => new Promise<VoiceCapture>((_, fail) => { reject = fail; }));
  const { view, props } = setup();
  view.unmount();
  await act(async () => reject(new DOMException("denied", "NotAllowedError")));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(props.onError).not.toHaveBeenCalled();
});

it("ignores a late settings failure after the dialog closes", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(invoke).mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  setup();
  const settings = await screen.findByRole("button", { name: "打开系统设置" });
  await act(async () => { fireEvent.click(settings); });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "已开启，重试" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "暂不使用" }));
  await act(async () => reject(new Error("late failure")));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([
  [new DOMException("missing", "NotFoundError"), "没有检测到麦克风设备"],
  [new DOMException("busy", "NotReadableError"), "麦克风正被其他程序占用"],
  [new Error("403 Forbidden"), "语音识别鉴权失败，请检查 API Key"],
])("keeps unrelated errors out of the permission dialog (%s)", async (error, message) => {
  vi.mocked(startVoiceCapture).mockRejectedValue(error);
  const { props } = setup();
  await act(async () => {});
  expect(props.onError).toHaveBeenCalledExactlyOnceWith(message);
  expect(screen.queryByRole("dialog")).toBeNull();
});
