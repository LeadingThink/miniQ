// @vitest-environment jsdom
import { useState } from "react";
import { createPortal } from "react-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ platform: "ios", available: true, update: vi.fn(), getState: vi.fn(),
  reload: vi.fn(), goBack: vi.fn(), addListener: vi.fn(), remove: vi.fn(), menu: null as (() => void) | null,
  back: null as (() => void) | null }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true,
  getPlatform: () => native.platform, isPluginAvailable: () => native.available }, registerPlugin: () => native }));
vi.mock("./MobileAppearanceSheet", () => ({ useMobileBackButton: (callback: () => void, enabled: boolean) => {
  native.back = enabled ? callback : null;
} }));
import { MobilePlatformShell } from "./MobilePlatformShell";
import { MobilePlatformTitle } from "./MobilePlatformTitle";

const ready = { loading: false, canGoBack: false, error: null };
function Draft() {
  const [text, setText] = useState("");
  return <><header data-testid="existing-header"><MobilePlatformTitle /></header><textarea aria-label="miniQ 草稿" value={text} onChange={(event) => setText(event.target.value)} /></>;
}
async function openMenu() {
  const trigger = screen.queryByRole("button", { name: /^(miniQ|在问)$/ });
  if (trigger) fireEvent.click(trigger);
  else await act(async () => { native.menu?.(); });
}
async function switchTo(name: string) {
  await openMenu();
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}
beforeEach(() => {
  vi.resetAllMocks(); native.platform = "ios"; native.available = true; native.back = null;
  native.update.mockResolvedValue(ready); native.getState.mockResolvedValue(ready);
  native.reload.mockResolvedValue(ready); native.goBack.mockResolvedValue({ navigated: false });
  native.addListener.mockImplementation(async (_event, callback) => { native.menu = callback; return { remove: native.remove }; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 64, top: 64,
    left: 0, right: 390, bottom: 784, width: 390, height: 720, toJSON: () => ({}) });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("places the miniQ switch in the existing page header without adding a header row", () => {
  render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  expect(screen.getByRole("button", { name: "miniQ" }).closest("header")).toBe(screen.getByTestId("existing-header"));
  expect(document.querySelectorAll("header")).toHaveLength(1);
});

it("opens one shared menu from the site navigation signal and removes its listener", async () => {
  const { unmount } = render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  await switchTo("在问");
  await waitFor(() => expect(native.addListener).toHaveBeenCalledWith("platformMenuRequested", expect.any(Function)));
  await act(async () => { native.menu?.(); });
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "在问" }).closest("header")).toBeNull();
  unmount();
  await waitFor(() => expect(native.remove).toHaveBeenCalled());
});

it.each(["ios", "android"])("switches to the real site and back without losing the miniQ draft on %s", async (platform) => {
  native.platform = platform;
  render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  fireEvent.change(screen.getByLabelText("miniQ 草稿"), { target: { value: "保留这个草稿" } });
  expect(native.update.mock.calls.some(([options]) => options.visible)).toBe(false);
  await switchTo("在问");
  await waitFor(() => expect(native.update).toHaveBeenCalledWith(expect.objectContaining({ visible: true, y: 64 })));
  expect(screen.getByRole("main", { name: "在问主站" }).querySelector("iframe")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "miniQ 草稿" })).toBeNull();
  await switchTo("miniQ");
  await waitFor(() => expect(native.update).toHaveBeenLastCalledWith({ visible: false }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("textbox", { name: "miniQ 草稿" })).toHaveProperty("value", "保留这个草稿");
});

it("keeps the native site visible while the switch menu is open", async () => {
  render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  await switchTo("在问");
  await waitFor(() => expect(native.update).toHaveBeenCalledWith(expect.objectContaining({ visible: true })));
  await openMenu();
  await waitFor(() => expect(native.update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true })));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(native.update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true })));
});

it("hides the native site for application dialogs and resumes it after they close", async () => {
  const { rerender } = render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  await switchTo("在问");
  await waitFor(() => expect(native.update).toHaveBeenCalledWith(expect.objectContaining({ visible: true })));
  rerender(<MobilePlatformShell><Draft />{createPortal(<div role="dialog" aria-modal="true">更新提示</div>, document.body)}</MobilePlatformShell>);
  await screen.findByRole("dialog");
  await waitFor(() => expect(native.update).toHaveBeenLastCalledWith({ visible: false }));
  rerender(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  await waitFor(() => expect(native.update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true })));
});

it.each(["miniQ", "在问"])("closes the switch menu first on the native back button from %s", async (platform) => {
  render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  if (platform === "在问") await switchTo("在问");
  await openMenu();
  await screen.findByRole("menu");
  await act(async () => { native.back?.(); });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.querySelector(".mobile-platform-shell")?.getAttribute("data-platform")).toBe(platform === "miniQ" ? "miniq" : "zaiwen");
  expect(native.goBack).not.toHaveBeenCalled();
});

it("dismisses the switch menu when an application modal opens", async () => {
  const { rerender } = render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  fireEvent.click(screen.getByRole("button", { name: "miniQ" }));
  await screen.findByRole("menu");
  rerender(<MobilePlatformShell><Draft />{createPortal(<div role="dialog" aria-modal="true">更新提示</div>, document.body)}</MobilePlatformShell>);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("shows a recoverable load error and keeps miniQ reachable", async () => {
  native.update.mockResolvedValue({ ...ready, error: "连接失败" });
  native.getState.mockResolvedValue({ ...ready, error: "连接失败" });
  render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  await switchTo("在问");
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "重试打开在问" }));
  await waitFor(() => expect(native.reload).toHaveBeenCalledOnce());
  await switchTo("miniQ");
  expect(screen.getByRole("textbox")).toBeTruthy();
});

it("uses native history first and then returns to miniQ on Android back", async () => {
  render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  await switchTo("在问");
  native.goBack.mockResolvedValueOnce({ navigated: true });
  await act(async () => { native.back?.(); });
  expect(document.querySelector(".mobile-platform-shell")?.getAttribute("data-platform")).toBe("zaiwen");
  await act(async () => { native.back?.(); });
  expect(screen.getByRole("button", { name: "miniQ" })).toBeTruthy();
});

it("reports a missing native plugin without using a cross-origin iframe or losing miniQ", async () => {
  native.available = false;
  render(<MobilePlatformShell><Draft /></MobilePlatformShell>);
  await switchTo("在问");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("原生手机版"));
  expect(native.update).not.toHaveBeenCalled();
  await switchTo("miniQ");
  expect(screen.getByRole("textbox")).toBeTruthy();
});
