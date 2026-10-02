import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: true,
  available: true,
  markBadge: vi.fn(async (_: { session: string }) => ({ count: 1 })),
  clearBadge: vi.fn(async () => ({ count: 0 })),
  appListener: null as ((state: { isActive: boolean }) => void) | null,
  remove: vi.fn(async () => undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isPluginAvailable: () => mocks.available },
  registerPlugin: () => ({}),
}));
vi.mock("./mobileRuntime", () => ({ isNativeMobileApp: () => mocks.native }));
vi.mock("./miniqPushPlugin", () => ({
  MiniqPush: { markBadge: mocks.markBadge, clearBadge: mocks.clearBadge },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: async (_: string, listener: (state: { isActive: boolean }) => void) => {
      mocks.appListener = listener;
      return { remove: mocks.remove };
    },
  },
}));

import { badgeSessionKey, clearAppBadge, markAppBadge, startAppBadge } from "./appBadge";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("appBadge", () => {
  beforeEach(() => {
    mocks.native = true;
    mocks.available = true;
    mocks.appListener = null;
    mocks.markBadge.mockClear();
    mocks.clearBadge.mockClear();
    mocks.remove.mockClear();
  });

  it("keys sessions per host so equal ids on different computers count twice", () => {
    expect(badgeSessionKey(null, "s1")).toBe("s1");
    expect(badgeSessionKey("h1", "s1")).toBe("h1\u0000s1");
  });

  it("marks a session and returns the native count", async () => {
    mocks.markBadge.mockResolvedValueOnce({ count: 3 });
    await expect(markAppBadge("h1", "s1")).resolves.toBe(3);
    expect(mocks.markBadge).toHaveBeenCalledWith({ session: "h1\u0000s1" });
  });

  it("never throws when the native side fails", async () => {
    mocks.markBadge.mockRejectedValueOnce(new Error("boom"));
    await expect(markAppBadge(null, "s1")).resolves.toBeNull();
    mocks.clearBadge.mockRejectedValueOnce(new Error("boom"));
    await expect(clearAppBadge()).resolves.toBeUndefined();
  });

  it("does nothing outside the native mobile app", async () => {
    mocks.native = false;
    await expect(markAppBadge(null, "s1")).resolves.toBeNull();
    await clearAppBadge();
    startAppBadge()();
    expect(mocks.markBadge).not.toHaveBeenCalled();
    expect(mocks.clearBadge).not.toHaveBeenCalled();
  });

  it("does nothing when the native plugin is missing", async () => {
    mocks.available = false;
    await expect(markAppBadge(null, "s1")).resolves.toBeNull();
    expect(mocks.markBadge).not.toHaveBeenCalled();
  });

  it("clears on start and each time the app returns to the foreground", async () => {
    const stop = startAppBadge();
    await flush();
    expect(mocks.clearBadge).toHaveBeenCalledTimes(1);
    mocks.appListener?.({ isActive: false });
    expect(mocks.clearBadge).toHaveBeenCalledTimes(1);
    mocks.appListener?.({ isActive: true });
    expect(mocks.clearBadge).toHaveBeenCalledTimes(2);
    stop();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it("removes a listener that registers after stop", async () => {
    startAppBadge()();
    await flush();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});
