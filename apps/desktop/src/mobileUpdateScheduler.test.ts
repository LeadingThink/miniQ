// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { MobileUpdateScheduler, UPDATE_CHECK_INTERVAL, UPDATE_FAILURE_COOLDOWN, UPDATE_REMINDER_COOLDOWN } from "./mobileUpdateScheduler";
import type { MobileUpdateState } from "./mobileUpdate";
const available: Extract<MobileUpdateState, { phase: "available" }> = { phase: "available", release: { version: "0.1.48", url: "https://oss.zaiwen.top/releases/miniq/android/v0.1.48/miniQ.apk", installationNotes: [] } };
beforeEach(() => localStorage.clear());
it("gates all checks", async () => {
  const check = vi.fn(); const scheduler = new MobileUpdateScheduler(check, () => false);
  expect(await scheduler.run(true)).toEqual({ phase: "idle" }); expect(check).not.toHaveBeenCalled();
});
it("persists throttling, permits manual checks and handles clock rollback", async () => {
  let now = 1_000_000; const check = vi.fn().mockResolvedValue(available);
  const scheduler = new MobileUpdateScheduler(check, () => true, () => now);
  expect(await scheduler.run()).toEqual(available);
  expect(await new MobileUpdateScheduler(check, () => true, () => now).run()).toEqual({ phase: "idle" });
  await scheduler.run(true); expect(check).toHaveBeenCalledTimes(2);
  now += UPDATE_CHECK_INTERVAL; await scheduler.run(); expect(check).toHaveBeenCalledTimes(3);
  now -= 100; await scheduler.run(); expect(check).toHaveBeenCalledTimes(4);
});
it("shares concurrent requests and gives manual checks ownership", async () => {
  let resolve!: (state: MobileUpdateState) => void;
  const check = vi.fn(() => new Promise<MobileUpdateState>((done) => { resolve = done; }));
  const scheduler = new MobileUpdateScheduler(check, () => true);
  const auto = scheduler.run(), duplicate = scheduler.run(), manual = scheduler.run(true);
  resolve(available);
  expect(await auto).toEqual({ phase: "idle" }); expect(await duplicate).toEqual({ phase: "idle" }); expect(await manual).toEqual(available);
  expect(check).toHaveBeenCalledTimes(1);
});
it("defers same version for 24 hours but permits newer versions and manual checks", async () => {
  let now = 1_000_000; const check = vi.fn().mockResolvedValue(available);
  const scheduler = new MobileUpdateScheduler(check, () => true, () => now);
  scheduler.defer("0.1.48"); expect(await scheduler.run()).toEqual({ phase: "idle" });
  expect(await scheduler.run(true)).toEqual(available);
  now += UPDATE_CHECK_INTERVAL;
  check.mockResolvedValue({ ...available, release: { ...available.release, version: "0.1.49" } });
  expect(await scheduler.run()).toMatchObject({ phase: "available" });
  now += UPDATE_REMINDER_COOLDOWN; check.mockResolvedValue(available);
  expect(await scheduler.run()).toEqual(available);
});
it("contains failures and retries after five minutes or manually", async () => {
  let now = 1_000_000; const check = vi.fn().mockRejectedValue(new Error("offline"));
  const scheduler = new MobileUpdateScheduler(check, () => true, () => now);
  expect(await scheduler.run()).toMatchObject({ phase: "error" });
  expect(await scheduler.run()).toEqual({ phase: "idle" });
  await scheduler.run(true); expect(check).toHaveBeenCalledTimes(2);
  now += UPDATE_FAILURE_COOLDOWN; check.mockResolvedValue(available);
  expect(await scheduler.run()).toEqual(available);
});
it("retains cooldown without storage", async () => {
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error(); });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error(); });
  const check = vi.fn().mockResolvedValue(available); const scheduler = new MobileUpdateScheduler(check, () => true);
  await scheduler.run(); expect(await scheduler.run()).toEqual({ phase: "idle" }); expect(check).toHaveBeenCalledTimes(1);
  get.mockRestore(); set.mockRestore();
});

const { mobileCheck } = vi.hoisted(() => ({ mobileCheck: vi.fn() }));
vi.mock("./mobileUpdate", async (original) => ({
  ...await original<typeof import("./mobileUpdate")>(), checkMobileUpdate: mobileCheck,
}));
it("uses mobile dispatcher by default and preserves iOS release", async () => {
  const ios = { phase: "available", release: { platform: "ios", version: "1.1", url: "https://apps.apple.com/cn/app/id6811485613", installationNotes: [] } };
  mobileCheck.mockResolvedValue(ios);
  const scheduler = new MobileUpdateScheduler(undefined, () => true);
  expect(await scheduler.run()).toEqual(ios);
  expect(mobileCheck).toHaveBeenCalledOnce();
});
