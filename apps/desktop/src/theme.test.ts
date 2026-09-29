// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  accentForeground,
  applyTheme,
  contrastRatio,
  getAppearance,
  initializeAppearance,
  isThemeId,
  resolveTheme,
  THEMES,
  LEGACY_THEMES,
  THEME_STORAGE_KEY,
  MODE_STORAGE_KEY,
  LAST_THEME_STORAGE_KEY,
  readStoredTheme,
  storeAppearanceMode,
  storeTheme,
  subscribeAppearance,
  themeById,
} from "./theme";
import { buildThemeBootstrap } from "./themeBootstrap";

let dark = false;
let changeListeners: Array<() => void> = [];
function stubSystem(isDark: boolean) {
  dark = isDark;
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, listener: () => void) => changeListeners.push(listener),
    }))
  );
}
function bootstrapTheme() {
  document.documentElement.removeAttribute("data-theme");
  window.eval(buildThemeBootstrap());
  return document.documentElement.dataset.theme;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  stubSystem(false);
  initializeAppearance();
  // 初始化会写入完整偏好；清掉以便各用例模拟老用户/新用户的存储状态。
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme catalog", () => {
  it("keeps three light and three dark themes, each paired with the other side", () => {
    expect(THEMES).toHaveLength(6);
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(6);
    expect(THEMES.filter((theme) => theme.mode === "light")).toHaveLength(3);
    for (const theme of THEMES) {
      expect(isThemeId(theme.id)).toBe(true);
      expect(resolveTheme(theme.id)).toBe(theme.id);
      const pair = themeById(theme.pair as never);
      expect(pair.mode).not.toBe(theme.mode);
      expect(pair.pair).toBe(theme.id);
    }
  });

  it("uses the canonical default for invalid values without accepting prototype keys", () => {
    for (const value of [null, undefined, "", "unknown-theme", "toString", "__proto__", 42, {}]) {
      expect(resolveTheme(value)).toBe("jade");
      expect(isThemeId(value)).toBe(false);
    }
  });

  it("maps every retired theme to a kept theme of the same brightness", () => {
    expect(Object.keys(LEGACY_THEMES).length).toBeGreaterThan(100);
    for (const next of Object.values(LEGACY_THEMES)) expect(isThemeId(next)).toBe(true);
    expect(LEGACY_THEMES["starry"] && themeById(LEGACY_THEMES["starry"]).mode).toBe("dark");
    expect(LEGACY_THEMES["rose"] && themeById(LEGACY_THEMES["rose"]).mode).toBe("light");
  });

  it.each(Object.entries(LEGACY_THEMES))("migrates %s to %s", (old, next) => {
    localStorage.setItem(THEME_STORAGE_KEY, old);
    expect(bootstrapTheme()).toBe(next);
    initializeAppearance();
    expect(getAppearance()).toMatchObject({ theme: next, mode: themeById(next).mode });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(next);
  });

  it.each(THEMES)("applies $id with readable text and matching initial paint", (theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    const root = document.documentElement;
    expect(bootstrapTheme()).toBe(theme.id);
    expect(root.style.getPropertyValue("--theme-page")).toBe(theme.preview.page);
    expect(root.style.colorScheme).toBe(theme.mode);
    applyTheme(theme.id);
    expect(root.dataset.themeMode).toBe(theme.mode);
    expect(root.dataset.themePattern).toBeUndefined();
    for (const [key, value] of Object.entries(theme.preview))
      expect(root.style.getPropertyValue(`--theme-${key}`)).toBe(value);
    expect(contrastRatio(theme.preview.accent, accentForeground(theme.preview.accent))).toBeGreaterThanOrEqual(4.5);
    for (const surface of [theme.preview.page, theme.preview.sidebar, theme.preview.surface]) {
      expect(contrastRatio(theme.preview.text, surface)).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("appearance mode", () => {
  it("follows the system for new users, including the first paint", () => {
    localStorage.clear();
    stubSystem(true);
    expect(readStoredTheme()).toBe("night");
    expect(bootstrapTheme()).toBe("night");
    initializeAppearance();
    expect(getAppearance().mode).toBe("system");
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe("system");
    stubSystem(false);
    expect(bootstrapTheme()).toBe("jade");
    initializeAppearance();
    expect(getAppearance()).toMatchObject({ mode: "system", theme: "jade" });
  });

  it("switches live when the system appearance changes", () => {
    storeTheme("snow");
    storeTheme("graphite");
    expect(getAppearance()).toMatchObject({ mode: "system", theme: "snow" });
    const listener = vi.fn();
    const unsubscribe = subscribeAppearance(listener);
    dark = true;
    changeListeners.forEach((change) => change());
    expect(getAppearance().theme).toBe("graphite");
    expect(document.documentElement.dataset.theme).toBe("graphite");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps a fixed mode and remembers each side independently", () => {
    storeAppearanceMode("dark");
    expect(getAppearance().theme).toBe("night");
    storeTheme("slate");
    storeTheme("amber");
    expect(getAppearance()).toMatchObject({ mode: "light", theme: "amber", lastThemes: { light: "amber", dark: "slate" } });
    storeAppearanceMode("dark");
    expect(getAppearance().theme).toBe("slate");
    initializeAppearance();
    expect(getAppearance()).toMatchObject({ mode: "dark", theme: "slate" });
    expect(bootstrapTheme()).toBe("slate");
    storeAppearanceMode("system");
    expect(getAppearance().theme).toBe("amber");
    expect(bootstrapTheme()).toBe("amber");
  });

  it("gives upgraded users the paired theme on the other side", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "snow");
    initializeAppearance();
    expect(getAppearance()).toMatchObject({ mode: "light", lastThemes: { light: "snow", dark: "slate" } });
    storeAppearanceMode("system");
    stubSystem(true);
    expect(bootstrapTheme()).toBe("slate");
  });

  it("drops retired preferences and validates malformed ones", () => {
    localStorage.setItem("miniq.appearance.favorites", '["rose"]');
    localStorage.setItem("miniq.appearance.character", "human-li-bai");
    localStorage.setItem(LAST_THEME_STORAGE_KEY, '{"light":"night","dark":"jade"}');
    localStorage.setItem(MODE_STORAGE_KEY, "sepia");
    initializeAppearance();
    // 非法明暗且无旧主题时按新用户处理（跟随系统），左右错位的 lastThemes 被纠正。
    expect(getAppearance()).toMatchObject({ mode: "system", lastThemes: { light: "jade", dark: "night" } });
    expect(localStorage.getItem("miniq.appearance.favorites")).toBeNull();
    expect(localStorage.getItem("miniq.appearance.character")).toBeNull();
    localStorage.setItem(LAST_THEME_STORAGE_KEY, "{broken");
    expect(() => bootstrapTheme()).not.toThrow();
  });

  it("retains preferences when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    initializeAppearance();
    storeAppearanceMode("dark");
    storeTheme("graphite");
    expect(getAppearance()).toMatchObject({ theme: "graphite", mode: "dark" });
    expect(document.documentElement.dataset.theme).toBe("graphite");
    expect(() => bootstrapTheme()).not.toThrow();
  });

  it("syncs appearance across windows, handles clearing storage and unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppearance(listener);
    localStorage.setItem(THEME_STORAGE_KEY, "slate");
    localStorage.setItem(MODE_STORAGE_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, storageArea: localStorage }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAppearance()).toMatchObject({ theme: "slate", mode: "dark" });
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, storageArea: sessionStorage }));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(listener).toHaveBeenCalledTimes(1);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    expect(getAppearance()).toMatchObject({ theme: "jade", mode: "system" });
    unsubscribe();
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
