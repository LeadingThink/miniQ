// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BillingDialog } from "./BillingDialog";

const { openExternalUrl, ios } = vi.hoisted(() => ({ openExternalUrl: vi.fn(), ios: { value: false } }));
vi.mock("../externalLinks", () => ({ openExternalUrl }));
vi.mock("../iosIap", () => ({ isIosIapAvailable: () => ios.value }));

const BALANCE = 'provider error: provider returned 402: {"type":"error","error":{"type":"insufficient_balance","message":"余额不足"}}';
const KEY_QUOTA = 'provider error: provider returned 401: {"type":"error","error":{"message":"Key quota used up","type":"invalid_request_error","code":"key_quota_exceeded"}}';

beforeEach(() => { ios.value = false; openExternalUrl.mockReset(); openExternalUrl.mockResolvedValue(undefined); });
afterEach(cleanup);

it("stays hidden for errors unrelated to billing", () => {
  render(<BillingDialog error="provider returned 500: boom" />);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("opens the billing page from a 402 balance error", async () => {
  render(<BillingDialog error={BALANCE} />);
  expect(screen.getByRole("alertdialog").textContent).toContain("余额不足");
  fireEvent.click(screen.getByRole("button", { name: "前往充值" }));
  await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://platform.zaiwenai.com/billing"));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("shows key-quota copy for a 401 key_quota_exceeded error", () => {
  render(<BillingDialog error={KEY_QUOTA} />);
  expect(screen.getByRole("alertdialog").textContent).toContain("API Key 额度已用完");
});

it("stays dismissed for the same error and reopens after the error clears", () => {
  const { rerender } = render(<BillingDialog error={BALANCE} />);
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  rerender(<BillingDialog error={BALANCE} />);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  rerender(<BillingDialog error={null} />);
  rerender(<BillingDialog error={BALANCE} />);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

it("closes on Escape and offers key replacement", () => {
  const onChangeKey = vi.fn();
  render(<BillingDialog error={BALANCE} onChangeKey={onChangeKey} />);
  fireEvent.click(screen.getByRole("button", { name: "更换 API Key" }));
  expect(onChangeKey).toHaveBeenCalledOnce();
  cleanup();
  render(<BillingDialog error={BALANCE} />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("tells the user the manual URL when the browser cannot open", async () => {
  openExternalUrl.mockRejectedValue(new Error("no browser"));
  render(<BillingDialog error={BALANCE} />);
  fireEvent.click(screen.getByRole("button", { name: "前往充值" }));
  expect((await screen.findByRole("alert")).textContent).toContain("https://platform.zaiwenai.com/billing");
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

it("never links to an external payment page on iOS", () => {
  ios.value = true;
  const onPurchase = vi.fn();
  const { rerender } = render(<BillingDialog error={BALANCE} />);
  expect(screen.queryByRole("button", { name: "前往充值" })).toBeNull();
  expect(screen.getByRole("alertdialog").textContent).toContain("账户、购买额度与 API Key");
  rerender(<BillingDialog error={BALANCE} onPurchase={onPurchase} />);
  fireEvent.click(screen.getByRole("button", { name: "购买额度" }));
  expect(onPurchase).toHaveBeenCalledOnce();
  expect(openExternalUrl).not.toHaveBeenCalled();
});
