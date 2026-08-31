export const THEME_STORAGE_KEY = "miniq.appearance.theme";

export const THEMES = [
  { id: "paper", name: "纸白", description: "清爽克制的默认外观", mode: "light", swatches: ["#f2f2f5", "#ffffff", "#1a1a1e"] },
  { id: "mist", name: "雾蓝", description: "安静、专注的冷色工作区", mode: "light", swatches: ["#edf4f7", "#fbfdfe", "#246b7a"] },
  { id: "rose", name: "玫瑰", description: "柔和但不甜腻的暖粉色", mode: "light", swatches: ["#f7f0f2", "#fffafb", "#a33d5d"] },
  { id: "grove", name: "森屿", description: "自然沉静的青绿层次", mode: "light", swatches: ["#edf3ef", "#fbfdfb", "#2f7257"] },
  { id: "sunrise", name: "暖阳", description: "明亮温暖的琥珀色调", mode: "light", swatches: ["#f7f2e9", "#fffdf8", "#a65f24"] },
  { id: "graphite", name: "石墨", description: "低干扰的中性深色界面", mode: "dark", swatches: ["#17191d", "#22252b", "#d7dae0"] },
  { id: "midnight", name: "深空", description: "适合夜间工作的深蓝色", mode: "dark", swatches: ["#111821", "#19232f", "#67a9d8"] },
  { id: "aurora", name: "极光", description: "青绿与紫色交织的暗色主题", mode: "dark", swatches: ["#121b1c", "#1a2828", "#63c2aa"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value);
}

export function resolveTheme(value: unknown): ThemeId {
  return isThemeId(value) ? value : "paper";
}

export function readStoredTheme(): ThemeId {
  try {
    return resolveTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "paper";
  }
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme =
    THEMES.find((candidate) => candidate.id === theme)?.mode ?? "light";
}

export function storeTheme(theme: ThemeId) {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The visual change still applies when storage is unavailable.
  }
}
