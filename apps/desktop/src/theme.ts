import { themeCatalog, type ThemeId, type ThemeMode } from "./themeCatalog";
import { themeCharacters, type ThemeCharacterId } from "./themeCharacters";

export { themeCatalog as THEMES } from "./themeCatalog";
export type { ThemeId } from "./themeCatalog";
export const THEME_STORAGE_KEY = "miniq.appearance.theme";
export const FAVORITES_STORAGE_KEY = "miniq.appearance.favorites";
export const CHARACTER_STORAGE_KEY = "miniq.appearance.character";
export const LAST_THEME_STORAGE_KEY = "miniq.appearance.lastThemes";
export const LEGACY_THEMES: Record<string, ThemeId> = {
  paper: "jade",
  mist: "ocean",
  grove: "forest",
  sunrise: "amber",
  midnight: "navy-office",
  aurora: "aurora-lake",
};

export interface Appearance {
  theme: ThemeId;
  character: ThemeCharacterId;
  favorites: ThemeId[];
  lastThemes: Record<ThemeMode, ThemeId>;
}

let current: Appearance | undefined;
const listeners = new Set<() => void>();

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && themeCatalog.some((theme) => theme.id === value);
}

export function resolveTheme(value: unknown, fallback: ThemeId = "jade"): ThemeId {
  if (isThemeId(value)) return value;
  return typeof value === "string" && Object.hasOwn(LEGACY_THEMES, value) ? LEGACY_THEMES[value] : fallback;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(read(key) ?? "null");
  } catch {
    return null;
  }
}

function persist(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Keep the in-memory preference usable in restricted webviews.
  }
}

export function readStoredTheme(): ThemeId {
  const dark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return resolveTheme(read(THEME_STORAGE_KEY), dark ? "night" : "jade");
}

function readAppearance(): Appearance {
  const favorites = readJson(FAVORITES_STORAGE_KEY);
  const character = themeCharacters.find((item) => item.id === read(CHARACTER_STORAGE_KEY))?.id ?? "none";
  const last = readJson(LAST_THEME_STORAGE_KEY) as Partial<Record<ThemeMode, unknown>> | null;
  const lastThemes: Record<ThemeMode, ThemeId> = { light: "jade", dark: "night" };
  for (const mode of ["light", "dark"] as const) {
    const id = resolveTheme(last?.[mode], lastThemes[mode]);
    if (themeCatalog.find((theme) => theme.id === id)?.mode === mode) lastThemes[mode] = id;
  }
  const theme = readStoredTheme();
  lastThemes[themeCatalog.find((item) => item.id === theme)!.mode] = theme;
  return {
    theme,
    character,
    lastThemes,
    favorites: Array.isArray(favorites) ? [...new Set(favorites.filter(isThemeId))] : [],
  };
}

export function getAppearance(): Appearance {
  return (current ??= readAppearance());
}

function syncStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  if (
    event.key !== null &&
    ![THEME_STORAGE_KEY, CHARACTER_STORAGE_KEY, FAVORITES_STORAGE_KEY, LAST_THEME_STORAGE_KEY].includes(event.key)
  )
    return;
  current = readAppearance();
  applyAppearance(current);
  listeners.forEach((listener) => listener());
}

export function subscribeAppearance(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener("storage", syncStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", syncStorage);
  };
}

export function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5]
      .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function accentForeground(accent: string): string {
  return contrastRatio(accent, "#ffffff") >= contrastRatio(accent, "#000000") ? "#ffffff" : "#000000";
}

export function applyTheme(id: ThemeId) {
  const theme = themeCatalog.find((item) => item.id === id)!;
  const root = document.documentElement;
  root.dataset.theme = id;
  root.dataset.themeMode = theme.mode;
  root.dataset.themePattern = theme.pattern;
  root.style.colorScheme = theme.mode;
  for (const [name, value] of Object.entries(theme.preview)) root.style.setProperty(`--theme-${name}`, value);
  root.style.setProperty("--accent-fg", accentForeground(theme.preview.accent));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.preview.page);
}

function applyAppearance(appearance: Appearance) {
  applyTheme(appearance.theme);
  const character = themeCharacters.find((item) => item.id === appearance.character)!;
  const root = document.documentElement;
  root.dataset.themeCharacter = character.id;
  root.style.setProperty(
    "--theme-character-watermark",
    character.watermarkAsset ? `url("${new URL(character.watermarkAsset, document.baseURI).href}")` : "none"
  );
}

export function initializeAppearance() {
  current = readAppearance();
  applyAppearance(current);
  persist(THEME_STORAGE_KEY, current.theme);
}

function updateAppearance(next: Appearance) {
  current = next;
  applyAppearance(next);
  listeners.forEach((listener) => listener());
}

export function storeTheme(theme: ThemeId) {
  const appearance = getAppearance();
  const mode = themeCatalog.find((item) => item.id === theme)!.mode;
  const lastThemes = { ...appearance.lastThemes, [mode]: theme };
  persist(THEME_STORAGE_KEY, theme);
  persist(LAST_THEME_STORAGE_KEY, JSON.stringify(lastThemes));
  updateAppearance({ ...appearance, theme, lastThemes });
}

export function storeCharacter(character: ThemeCharacterId) {
  persist(CHARACTER_STORAGE_KEY, character);
  updateAppearance({ ...getAppearance(), character });
}

export function toggleFavorite(theme: ThemeId) {
  const appearance = getAppearance();
  const favorites = appearance.favorites.includes(theme)
    ? appearance.favorites.filter((id) => id !== theme)
    : [...appearance.favorites, theme];
  persist(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  updateAppearance({ ...appearance, favorites });
}
