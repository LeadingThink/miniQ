// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ recover: vi.fn(), observe: vi.fn(), appListener: vi.fn(), remove: vi.fn(), consent: true }));
vi.mock("../iosIap", () => ({ isIosIapAvailable: () => true, recoverIosTransactions: mocks.recover, observeIosTransactions: mocks.observe }));
vi.mock("../mobilePrivacy", () => ({ hasMobilePrivacyConsent: () => mocks.consent }));
vi.mock("@capacitor/app", () => ({ App: { addListener: mocks.appListener } }));
import { useIosIapRecovery } from "./useIosIapRecovery";
beforeEach(() => {
  vi.resetAllMocks(); mocks.consent = true; mocks.recover.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.observe.mockResolvedValue({ remove: mocks.remove }); mocks.appListener.mockResolvedValue({ remove: mocks.remove });
});
afterEach(cleanup);
it("recovers on startup, StoreKit updates and foreground, then removes listeners", async () => {
  const { unmount } = renderHook(useIosIapRecovery);
  await waitFor(() => expect(mocks.recover).toHaveBeenCalledTimes(1));
  await act(async () => mocks.observe.mock.calls[0][0]());
  expect(mocks.recover).toHaveBeenCalledTimes(2);
  await act(async () => mocks.appListener.mock.calls[0][1]({ isActive: true }));
  expect(mocks.recover).toHaveBeenCalledTimes(3);
  unmount(); expect(mocks.remove).toHaveBeenCalledTimes(2);
});
it("waits for privacy consent and retries a failed recovery on a later foreground event", async () => {
  mocks.consent = false;
  renderHook(useIosIapRecovery);
  expect(mocks.recover).not.toHaveBeenCalled();
  mocks.consent = true; mocks.recover.mockRejectedValueOnce(new Error("offline"));
  await act(async () => mocks.appListener.mock.calls[0][1]({ isActive: true }));
  await act(async () => mocks.appListener.mock.calls[0][1]({ isActive: true }));
  expect(mocks.recover).toHaveBeenCalledTimes(2);
});
it("queues updates arriving during recovery instead of overlapping or losing them", async () => {
  let finish!: () => void;
  mocks.recover.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  renderHook(useIosIapRecovery);
  await act(async () => { mocks.observe.mock.calls[0][0](); mocks.observe.mock.calls[0][0](); });
  expect(mocks.recover).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(mocks.recover).toHaveBeenCalledTimes(2);
});
