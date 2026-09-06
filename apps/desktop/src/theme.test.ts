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
  CHARACTER_STORAGE_KEY,
  FAVORITES_STORAGE_KEY,
  LAST_THEME_STORAGE_KEY,
  readStoredTheme,
  storeTheme,
  storeCharacter,
  toggleFavorite,
  subscribeAppearance,
} from "./theme";
import { themeCategories } from "./themeCatalog";
import { themeCharacters } from "./themeCharacters";
import { buildThemeBootstrap } from "./themeBootstrap";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  initializeAppearance();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme selection", () => {
  it("keeps every registered theme id", () => {
    for (const theme of THEMES) {
      expect(isThemeId(theme.id)).toBe(true);
      expect(resolveTheme(theme.id)).toBe(theme.id);
    }
  });

  it("uses the canonical default for invalid values without accepting prototype keys", () => {
    for (const value of [null, undefined, "", "unknown-theme", "toString", "__proto__", 42, {}]) {
      expect(resolveTheme(value)).toBe("jade");
      expect(isThemeId(value)).toBe(false);
    }
  });

  it("has the full nine-category Web catalog without duplicates", () => {
    expect(THEMES).toHaveLength(108);
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(108);
    expect(themeCategories).toHaveLength(9);
    expect(new Set(THEMES.map((theme) => theme.pattern)).size).toBe(16);
    expect(THEMES.filter((theme) => theme.featured)).toHaveLength(25);
    for (const category of themeCategories)
      expect(THEMES.filter((theme) => theme.category === category.id)).toHaveLength(12);
    expect(themeCharacters).toHaveLength(10);
  });

  it.each(Object.entries(LEGACY_THEMES))("migrates %s to %s", (old, next) => {
    localStorage.setItem(THEME_STORAGE_KEY, old);
    window.eval(buildThemeBootstrap());
    expect(document.documentElement.dataset.theme).toBe(next);
    initializeAppearance();
    expect(getAppearance().theme).toBe(next);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(next);
  });

  it.each(THEMES)("applies $id with readable text and matching initial paint", (theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    window.eval(buildThemeBootstrap());
    const root = document.documentElement;
    expect(root.dataset.theme).toBe(theme.id);
    expect(root.style.getPropertyValue("--theme-page")).toBe(theme.preview.page);
    expect(root.style.colorScheme).toBe(theme.mode);
    applyTheme(theme.id);
    expect(root.dataset.themePattern).toBe(theme.pattern);
    expect(root.dataset.themeMode).toBe(theme.mode);
    for (const [key, value] of Object.entries(theme.preview))
      expect(root.style.getPropertyValue(`--theme-${key}`)).toBe(value);
    expect(contrastRatio(theme.preview.accent, accentForeground(theme.preview.accent))).toBeGreaterThanOrEqual(4.5);
    for (const surface of [theme.preview.page, theme.preview.sidebar, theme.preview.surface]) {
      expect(contrastRatio(theme.preview.text, surface)).toBeGreaterThanOrEqual(7);
    }
  });

  it("uses system darkness only when there is no saved preference", () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(readStoredTheme()).toBe("night");
    window.eval(buildThemeBootstrap());
    expect(document.documentElement.dataset.theme).toBe("night");
    storeTheme("rose");
    expect(readStoredTheme()).toBe("rose");
  });

  it("retains preferences when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    initializeAppearance();
    storeTheme("starry");
    storeCharacter("human-li-bai");
    toggleFavorite("starry");
    expect(getAppearance()).toMatchObject({ theme: "starry", character: "human-li-bai", favorites: ["starry"] });
    expect(document.documentElement.dataset.theme).toBe("starry");
    expect(() => window.eval(buildThemeBootstrap())).not.toThrow();
  });

  it("remembers light and dark choices independently", () => {
    storeTheme("rose");
    storeTheme("starry");
    initializeAppearance();
    expect(getAppearance().lastThemes).toEqual({ light: "rose", dark: "starry" });
  });

  it("validates malformed stored preferences", () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, '["rose","rose","unknown",42]');
    localStorage.setItem(CHARACTER_STORAGE_KEY, "../../untrusted");
    localStorage.setItem(LAST_THEME_STORAGE_KEY, '{"light":"starry","dark":"rose"}');
    initializeAppearance();
    expect(getAppearance()).toMatchObject({
      favorites: ["rose"],
      character: "none",
      lastThemes: { light: "jade", dark: "night" },
    });
    localStorage.setItem(FAVORITES_STORAGE_KEY, "{broken");
    initializeAppearance();
    expect(getAppearance().favorites).toEqual([]);
  });

  it("persists all favorites and keeps characters independent of theme changes", () => {
    THEMES.forEach((theme) => toggleFavorite(theme.id));
    storeCharacter("human-ada-lovelace");
    storeTheme("night");
    initializeAppearance();
    expect(getAppearance().favorites).toHaveLength(108);
    expect(getAppearance().character).toBe("human-ada-lovelace");
    expect(document.documentElement.style.getPropertyValue("--theme-character-watermark")).toContain(
      "human-ada-lovelace-watermark.png"
    );
    storeCharacter("none");
    expect(document.documentElement.style.getPropertyValue("--theme-character-watermark")).toBe("none");
    toggleFavorite("rose");
    expect(getAppearance().favorites).not.toContain("rose");
  });

  it("syncs appearance across windows, handles clearing storage and unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppearance(listener);
    localStorage.setItem(THEME_STORAGE_KEY, "polar-night");
    localStorage.setItem(CHARACTER_STORAGE_KEY, "human-su-shi");
    localStorage.setItem(FAVORITES_STORAGE_KEY, '["polar-night"]');
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, storageArea: localStorage }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAppearance()).toMatchObject({
      theme: "polar-night",
      character: "human-su-shi",
      favorites: ["polar-night"],
    });
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, storageArea: sessionStorage }));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(listener).toHaveBeenCalledTimes(1);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    expect(getAppearance()).toMatchObject({ theme: "jade", character: "none", favorites: [] });
    unsubscribe();
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
