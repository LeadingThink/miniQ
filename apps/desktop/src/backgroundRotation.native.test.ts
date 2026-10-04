// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AppState } from "@capacitor/app";
vi.mock("./mobileRuntime", () => ({ isNativeMobileApp: () => true }));
import { initializeRotation, updateRotation, advanceRotation, resetRotationForTest } from "./backgroundRotation";
import { WALLPAPER_CHANGE_EVENT, ROTATION_STORAGE_KEY } from "./appearanceStorage";
import { createMobileBackgroundPolicy } from "./mobileBackgroundPolicy";
afterEach(() => { resetRotationForTest(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });
it("never starts the desktop rotation scheduler on native, including shared change notifications", async () => {
  vi.useFakeTimers();
  initializeRotation();
  updateRotation({ enabled: true });
  window.dispatchEvent(new CustomEvent(WALLPAPER_CHANGE_EVENT, { detail: [ROTATION_STORAGE_KEY] }));
  expect(advanceRotation()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  const policy = createMobileBackgroundPolicy({
    isNative: () => true,
    app: {
      addListener: async (event, listener) => {
        if (event === "appStateChange") {
          (listener as (state: AppState) => void)({ isActive: true });
        }
        return { remove: async () => {} };
      },
      getState: async () => ({ isActive: true }),
    },
    network: { getStatus: async () => ({ connected: true, connectionType: "wifi" }) },
    device: { getBatteryInfo: async () => ({ isCharging: true, batteryLevel: 1 }) },
    power: async () => ({ lowPower: false }),
  });
  // Count rotation timeouts independently of battery intervals and jsdom’s zero-delay storage-event tasks.
  const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const id = originalSet(...args); if (Number(args[1]) > 0) activeTimeouts.add(id); return id;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
    activeTimeouts.delete(id as ReturnType<typeof setTimeout>); originalClear(id);
  });
  try {
    await policy.start();
    policy.setPreferences({ rotation: { ...policy.getSnapshot().preferences.rotation, enabled: true } });
    const schedulerCount = activeTimeouts.size;
    expect(schedulerCount).toBeLessThanOrEqual(1);
    policy.setPreferences({ rotation: { ...policy.getSnapshot().preferences.rotation, interval: 30 } });
    expect(activeTimeouts.size).toBe(schedulerCount);
  } finally { policy.stop(); }
  expect(activeTimeouts.size).toBe(0);
});
