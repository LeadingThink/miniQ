// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPanel } from "./Settings";
import { MobileAppearanceSheet } from "./MobileAppearanceSheet";
import { mobileBackgroundPolicy } from "../mobileBackgroundPolicy";
import { initializeAppearance, getAppearance } from "../theme";
import { BACKGROUNDS } from "../backgroundCatalog";
import type { RpcClient } from "../rpc";
const runtime = vi.hoisted(() => ({ mobile: true }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => runtime.mobile }));
vi.mock("./ComputerSettings", () => ({ ComputerSettings: () => null }));
beforeEach(() => {
  runtime.mobile = true;
  localStorage.clear();
  initializeAppearance();
  mobileBackgroundPolicy.setPreferences({ background: "none" });
});
afterEach(() => { cleanup(); mobileBackgroundPolicy.stop(); });
const client = { mode: "remote", call: vi.fn(async () => ({})) } as unknown as RpcClient;
it("uses the same mobile theme and wallpaper controls in remote Settings and the phone sheet", async () => {
  await act(async () => { render(<><MobileAppearanceSheet /><SettingsPanel client={client} theme="jade" initialTab="appearance" onThemeChange={() => {}} onClose={() => {}} /></>); });
  const standalone = within(screen.getByRole("dialog", { name: "外观" }));
  const embedded = within(document.querySelector(".mobile-appearance-embedded")! as HTMLElement);
  expect(embedded.getByRole("combobox", { name: "轮播间隔" })).toBeTruthy();
  expect(embedded.queryByRole("radiogroup", { name: "背景" })).toBeNull();
  fireEvent.click(embedded.getByRole("radio", { name: "深色" }));
  expect(getAppearance().mode).toBe("dark");
  expect((standalone.getByRole("radio", { name: "深色" }) as HTMLInputElement).checked).toBe(true);
  const wallpaper = BACKGROUNDS.find(item => item.kind !== "none")!;
  fireEvent.click(embedded.getByRole("radio", { name: wallpaper.name }));
  expect(mobileBackgroundPolicy.getSnapshot().preferences.background).toBe(wallpaper.id);
  expect((standalone.getByRole("radio", { name: wallpaper.name }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(standalone.getByRole("combobox", { name: "轮播间隔" }), { target: { value: "30" } });
  expect((embedded.getByRole("combobox", { name: "轮播间隔" }) as HTMLSelectElement).value).toBe("30");
});
it("keeps the desktop appearance picker on desktop", async () => {
  runtime.mobile = false;
  await act(async () => { render(<SettingsPanel client={client} theme="jade" initialTab="appearance" onThemeChange={() => {}} onClose={() => {}} />); });
  expect(document.querySelector(".mobile-appearance-embedded")).toBeNull();
  expect(screen.getByRole("radiogroup", { name: "背景" })).toBeTruthy();
});
