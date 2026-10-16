// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileEntry } from "./MobileEntry";

vi.mock("../iosIap", () => ({ isIosIapAvailable: () => false }));
vi.mock("../mobileAccountPlatform", () => ({ isMobileAccountAvailable: () => true }));
vi.mock("./MobileUpdateCheck", () => ({ MobileUpdateCheck: () => null }));
vi.mock("./MobileAccountPanel", () => ({ MobileAccountPanel: () => <p>account panel</p> }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("miniq.remote.credentials.v1", JSON.stringify({ apiKey: "sk-existing-key", deviceId: "mobile-test", deviceName: "Android" }));
  localStorage.setItem("miniq.mobile.privacyConsent.v1", "2026-09-16");
});
afterEach(cleanup);

it("shows the same Key entry and account button on Android as on iOS, without the purchase wording", () => {
  render(<MobileEntry onRemote={vi.fn()} />);
  expect((screen.getByLabelText("在问 API Key") as HTMLInputElement).value).toBe("sk-existing-key");
  expect(screen.getByRole("button", { name: "保存 Key" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "账户、购买额度与 API Key" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "账户、充值与 API Key" }));
  expect(screen.getByText("account panel")).toBeTruthy();
});
