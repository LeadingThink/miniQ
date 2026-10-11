// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompanionSettings } from "./CompanionSettings";
import { setCompanionMode } from "../companionPrefs";

const runtime = vi.hoisted(() => ({ tauri: true }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => runtime.tauri }));
vi.mock("../companionPrefs", () => ({
  DEFAULT_COMPANION_PREFS: { mode: "hidden" },
  readCompanionPrefs: vi.fn(async () => ({ mode: "hidden" })),
  listenCompanionPrefs: vi.fn(async () => () => {}),
  setCompanionMode: vi.fn(async (mode) => ({ mode })),
}));
afterEach(() => {
  cleanup();
  runtime.tauri = true;
  vi.mocked(setCompanionMode).mockClear();
});

const option = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

it("stays hidden until the user explicitly enables a mode and changes only companion preferences", async () => {
  render(<CompanionSettings />);
  expect(screen.getByRole("group", { name: "桌面伙伴外观" })).toBeTruthy();
  await waitFor(() => expect(option("小伙伴").disabled).toBe(false));
  expect(option("隐藏").getAttribute("aria-pressed")).toBe("true");
  expect(option("小伙伴").getAttribute("aria-pressed")).toBe("false");
  expect(setCompanionMode).not.toHaveBeenCalled();
  fireEvent.click(option("小伙伴"));
  await waitFor(() => expect(option("小伙伴").getAttribute("aria-pressed")).toBe("true"));
  expect(setCompanionMode).toHaveBeenCalledExactlyOnceWith("pet");
  expect(option("隐藏").getAttribute("aria-pressed")).toBe("false");
});

it("shows the error and keeps the previous mode when saving fails", async () => {
  vi.mocked(setCompanionMode).mockRejectedValueOnce(new Error("保存失败"));
  render(<CompanionSettings />);
  await waitFor(() => expect(option("圆点").disabled).toBe(false));
  fireEvent.click(option("圆点"));
  expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
  expect(option("隐藏").getAttribute("aria-pressed")).toBe("true");
});

it("renders a disabled note outside the desktop client", () => {
  runtime.tauri = false;
  render(<CompanionSettings />);
  expect(screen.getByText("仅桌面客户端可用")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "桌面伙伴外观" })).toBeNull();
});
