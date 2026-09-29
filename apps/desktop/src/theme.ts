import { LEGACY_THEMES, themeCatalog, type ThemeId, type ThemeMode } from "./themeCatalog";

export { themeCatalog as THEMES, LEGACY_THEMES } from "./themeCatalog";
export type { ThemeId, ThemeMode } from "./themeCatalog";
export const THEME_STORAGE_KEY = "miniq.appearance.theme";
export const MODE_STORAGE_KEY = "miniq.appearance.mode";
export const LAST_THEME_STORAGE_KEY = "miniq.appearance.lastThemes";
/** 旧版的收藏与角色设置已随主题精简移除，启动时顺带清理。 */
const RETIRED_STORAGE_KEYS = ["miniq.appearance.favorites", "miniq.appearance.character"];

/** “自动”跟随系统明暗，和 macOS 外观设置一致。 */
export type AppearanceMode = "system" | ThemeMode;

export interface Appearance {
  /** 当前实际生效的主题。 */
  theme: ThemeId;
  mode: AppearanceMode;
  /** 浅色、深色各自选用的主题。 */
  lastThemes: Record<ThemeMode, ThemeId>;
}

const DEFAULT_THEMES: Record<ThemeMode, ThemeId> = { light: "jade", dark: "night" };
const DARK_QUERY = "(prefers-color-scheme: dark)";

let current: Appearance | undefined;
const listeners = new Set<() => void>();

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && themeCatalog.some((theme) => theme.id === value);
}

export function themeById(id: ThemeId) {
  return themeCatalog.find((theme) => theme.id === id)!;
}

export function resolveTheme(value: unknown, fallback: ThemeId = "jade"): ThemeId {
  if (isThemeId(value)) return value;
  return typeof value === "string" && Object.hasOwn(LEGACY_THEMES, value) ? LEGACY_THEMES[value] : fallback;
}

function systemMode(): ThemeMode {
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
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

function remove(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clean up in restricted webviews.
  }
}

function effectiveTheme(mode: AppearanceMode, lastThemes: Record<ThemeMode, ThemeId>): ThemeId {
  return lastThemes[mode === "system" ? systemMode() : mode];
}

export function readStoredTheme(): ThemeId {
  return readAppearance().theme;
}

function readAppearance(): Appearance {
  const storedRaw = read(THEME_STORAGE_KEY);
  const stored = storedRaw === null ? undefined : resolveTheme(storedRaw, DEFAULT_THEMES[systemMode()]);
  const last = readJson(LAST_THEME_STORAGE_KEY) as Partial<Record<ThemeMode, unknown>> | null;
  const lastThemes = { ...DEFAULT_THEMES };
  if (stored) {
    // 只选过一种明暗的老用户：另一侧默认用同色系的配对主题。
    const theme = themeById(stored);
    lastThemes[theme.mode] = stored;
    lastThemes[theme.mode === "light" ? "dark" : "light"] = theme.pair as ThemeId;
  }
  for (const mode of ["light", "dark"] as const) {
    const id = resolveTheme(last?.[mode], lastThemes[mode]);
    if (themeById(id).mode === mode) lastThemes[mode] = id;
  }
  if (stored) lastThemes[themeById(stored).mode] = stored;
  const storedMode = read(MODE_STORAGE_KEY);
  // 新用户默认跟随系统；老用户保留原来选定的明暗。
  const mode: AppearanceMode =
    storedMode === "system" || storedMode === "light" || storedMode === "dark"
      ? storedMode
      : stored
        ? themeById(stored).mode
        : "system";
  return { theme: effectiveTheme(mode, lastThemes), mode, lastThemes };
}

export function getAppearance(): Appearance {
  return (current ??= readAppearance());
}

function notify() {
  listeners.forEach((listener) => listener());
}

function syncStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  if (event.key !== null && ![THEME_STORAGE_KEY, MODE_STORAGE_KEY, LAST_THEME_STORAGE_KEY].includes(event.key)) return;
  current = readAppearance();
  applyTheme(current.theme);
  notify();
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
  const theme = themeById(id);
  const root = document.documentElement;
  root.dataset.theme = id;
  root.dataset.themeMode = theme.mode;
  root.style.colorScheme = theme.mode;
  for (const [name, value] of Object.entries(theme.preview)) root.style.setProperty(`--theme-${name}`, value);
  root.style.setProperty("--accent-fg", accentForeground(theme.preview.accent));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.preview.page);
}

let systemQuery: MediaQueryList | undefined;
function followSystem() {
  const appearance = getAppearance();
  if (appearance.mode !== "system") return;
  const theme = effectiveTheme("system", appearance.lastThemes);
  if (theme === appearance.theme) return;
  update({ ...appearance, theme });
}

export function initializeAppearance() {
  current = readAppearance();
  applyTheme(current.theme);
  // 一次写全，避免新用户下次启动时被当成"只存了主题"的老用户而锁定明暗。
  persist(THEME_STORAGE_KEY, current.theme);
  persist(MODE_STORAGE_KEY, current.mode);
  persist(LAST_THEME_STORAGE_KEY, JSON.stringify(current.lastThemes));
  RETIRED_STORAGE_KEYS.forEach(remove);
  if (!systemQuery && typeof window !== "undefined" && window.matchMedia) {
    systemQuery = window.matchMedia(DARK_QUERY);
    systemQuery.addEventListener?.("change", followSystem);
  }
}

function update(next: Appearance) {
  current = next;
  persist(THEME_STORAGE_KEY, next.theme);
  persist(MODE_STORAGE_KEY, next.mode);
  persist(LAST_THEME_STORAGE_KEY, JSON.stringify(next.lastThemes));
  applyTheme(next.theme);
  notify();
}

/** 选定某个主题：记为对应明暗的首选；固定明暗时切到该主题所在的明暗。 */
export function storeTheme(theme: ThemeId) {
  const appearance = getAppearance();
  const themeMode = themeById(theme).mode;
  const lastThemes = { ...appearance.lastThemes, [themeMode]: theme };
  const mode = appearance.mode === "system" ? "system" : themeMode;
  update({ mode, lastThemes, theme: effectiveTheme(mode, lastThemes) });
}

export function storeAppearanceMode(mode: AppearanceMode) {
  const appearance = getAppearance();
  update({ ...appearance, mode, theme: effectiveTheme(mode, appearance.lastThemes) });
}
