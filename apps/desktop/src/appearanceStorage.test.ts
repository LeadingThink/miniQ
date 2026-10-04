// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_MIGRATION_KEY, BACKGROUND_STORAGE_KEY, ROTATION_STORAGE_KEY, migrateWallpaperPreferences } from "./appearanceStorage";
import { BACKGROUNDS } from "./backgroundCatalog";
import { createMobileBackgroundPolicy, readMobilePreferences, MOBILE_BACKGROUND_KEYS } from "./mobileBackgroundPolicy";
import { getActiveBackground, initializeBackground, storeBackground, subscribeBackground } from "./background";
import { getRotation, initializeRotation, resetRotationForTest, updateRotation } from "./backgroundRotation";

const [first, second] = BACKGROUNDS.filter(item => item.kind !== "none");
beforeEach(() => localStorage.clear());
afterEach(() => { resetRotationForTest(); vi.restoreAllMocks(); });
describe("shared wallpaper migration", () => {
  it("prioritizes the mobile choice and rotation on mobile exactly once", () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, first.id);
    localStorage.setItem(MOBILE_BACKGROUND_KEYS.background, "none");
    localStorage.setItem(ROTATION_STORAGE_KEY, JSON.stringify({ interval: 30 }));
    localStorage.setItem(MOBILE_BACKGROUND_KEYS.rotation, JSON.stringify({ interval: 5, enabled: true }));
    expect(readMobilePreferences(localStorage, true)).toMatchObject({ background: "none", rotation: { interval: 5, enabled: true } });
    expect(localStorage.getItem(APPEARANCE_MIGRATION_KEY)).toBe("1");
    localStorage.setItem(MOBILE_BACKGROUND_KEYS.background, first.id);
    localStorage.setItem(MOBILE_BACKGROUND_KEYS.rotation, JSON.stringify({ enabled: true }));
    localStorage.setItem(ROTATION_STORAGE_KEY, JSON.stringify({ enabled: false }));
    expect(readMobilePreferences(localStorage, true)).toMatchObject({ background: "none", rotation: { enabled: false } });
    localStorage.removeItem(BACKGROUND_STORAGE_KEY);
    expect(readMobilePreferences(localStorage, true).background).toBe("none");
  });
  it("falls back to desktop settings when no mobile setting exists", () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, first.id);
    localStorage.setItem(ROTATION_STORAGE_KEY, JSON.stringify({ interval: 30 }));
    expect(readMobilePreferences(localStorage, true)).toMatchObject({ background: first.id, rotation: { interval: 30 } });
  });
  it("keeps desktop choices on desktop even when stale mobile keys exist", () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, first.id);
    localStorage.setItem(MOBILE_BACKGROUND_KEYS.background, second.id);
    migrateWallpaperPreferences(localStorage, false);
    expect(readMobilePreferences(localStorage, true).background).toBe(first.id);
  });
  it("normalizes invalid migrated values without restoring old preferences", () => {
    localStorage.setItem(MOBILE_BACKGROUND_KEYS.background, "removed-wallpaper");
    localStorage.setItem(MOBILE_BACKGROUND_KEYS.rotation, "{");
    expect(readMobilePreferences(localStorage, true)).toMatchObject({ background: "none", rotation: { enabled: false } });
  });
});

it("updates live background and rotation consumers in both directions without reload", async () => {
  initializeBackground();
  initializeRotation();
  const unsubscribe = subscribeBackground(() => {});
  const policy = createMobileBackgroundPolicy({ isNative: () => false });
  try {
    await policy.start();
    storeBackground(first.id);
    expect(policy.getSnapshot().preferences.background).toBe(first.id);
    updateRotation({ enabled: false, interval: 30 });
    expect(policy.getSnapshot().preferences.rotation.interval).toBe(30);
    policy.setPreferences({ background: second.id, rotation: { ...policy.getSnapshot().preferences.rotation, interval: 5 } });
    expect(getActiveBackground().id).toBe(second.id);
    expect(getRotation().interval).toBe(5);
    policy.selectBackground("none");
    expect(getActiveBackground().kind).toBe("none");
    expect(document.documentElement.dataset.background).toBeUndefined();
    policy.stop();
    storeBackground(first.id);
    await policy.start();
    expect(policy.getSnapshot().preferences.background).toBe(first.id);
  } finally { policy.stop(); unsubscribe(); }
});

it("preserves synchronous mounted consumers and restarted policy when storage writes fail", async () => {
  initializeBackground();
  const unsubscribe = subscribeBackground(() => {});
  const policy = createMobileBackgroundPolicy({ isNative: () => false });
  try {
    await policy.start();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    policy.setPreferences({ background: second.id, rotation: { ...policy.getSnapshot().preferences.rotation, interval: 30 } });
    expect(getActiveBackground().id).toBe(second.id);
    expect(policy.getSnapshot().preferences.rotation.interval).toBe(30);
    storeBackground(first.id);
    expect(policy.getSnapshot().preferences.background).toBe(first.id);
    policy.stop();
    await policy.start();
    expect(policy.getSnapshot().preferences.background).toBe(first.id);
    expect(policy.getSnapshot().preferences.rotation.interval).toBe(30);
  } finally { policy.stop(); unsubscribe(); }
});

it("preserves live choices when even the localStorage getter is denied", async () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("denied"); });
  initializeBackground();
  const unsubscribe = subscribeBackground(() => {});
  const policy = createMobileBackgroundPolicy({ isNative: () => false });
  try {
    await policy.start();
    policy.selectBackground(second.id);
    expect(getActiveBackground().id).toBe(second.id);
    storeBackground(first.id);
    expect(policy.getSnapshot().preferences.background).toBe(first.id);
    policy.stop();
    await policy.start();
    expect(policy.getSnapshot().preferences.background).toBe(first.id);
  } finally { policy.stop(); unsubscribe(); }
});
