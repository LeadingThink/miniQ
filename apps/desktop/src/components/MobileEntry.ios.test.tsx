// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileEntry } from "./MobileEntry";

vi.mock("../iosIap", () => ({ isIosIapAvailable: () => true }));
vi.mock("./MobileUpdateCheck", () => ({ MobileUpdateCheck: () => null }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("miniq.remote.credentials.v1", JSON.stringify({
    apiKey: "sk-existing-key",
    deviceId: "mobile-test",
    deviceName: "iPhone",
  }));
  localStorage.setItem("miniq.mobile.privacyConsent.v1", "2026-09-16");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps the API Key field visible on the iOS home page for replacement", async () => {
  render(<MobileEntry onRemote={vi.fn()} />);

  const input = screen.getByLabelText("在问 API Key") as HTMLInputElement;
  expect(input.value).toBe("sk-existing-key");
  expect(screen.getByRole("button", { name: "账户、购买额度与 API Key" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "没有 API Key？登录购买额度 / 创建 Key" })).toBeNull();

  fireEvent.change(input, { target: { value: "sk-replaced-key" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 Key" }));

  await waitFor(() => expect(sessionStorage.getItem("miniq.remote.credentials.v1")).toContain("sk-replaced-key"));
});
