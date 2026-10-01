import { accentForeground, LAST_THEME_STORAGE_KEY, LEGACY_THEMES, MODE_STORAGE_KEY, THEMES, THEME_STORAGE_KEY } from "./theme";

// Vite embeds this from the same catalog, before CSS/React load, so every
// theme (including migrated IDs and "follow system") has a matching first paint.
export function buildThemeBootstrap(): string {
  const palettes = Object.fromEntries(
    THEMES.map(({ id, mode, pair, preview }) => [
      id,
      [mode, preview.page, preview.text, preview.accent, accentForeground(preview.accent), pair],
    ])
  );
  return `(() => {
    const palettes = ${JSON.stringify(palettes)};
    const aliases = ${JSON.stringify(LEGACY_THEMES)};
    const get = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
    const resolve = (value) => Object.hasOwn(aliases, value) ? aliases[value] : Object.hasOwn(palettes, value) ? value : null;
    const system = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const stored = resolve(get(${JSON.stringify(THEME_STORAGE_KEY)}));
    let mode = get(${JSON.stringify(MODE_STORAGE_KEY)});
    if (mode !== "system" && mode !== "light" && mode !== "dark") mode = stored ? palettes[stored][0] : "system";
    const target = mode === "system" ? system : mode;
    let id = stored && palettes[stored][0] === target ? stored : null;
    if (!id) {
      let last = null;
      try { last = JSON.parse(get(${JSON.stringify(LAST_THEME_STORAGE_KEY)}) ?? "null"); } catch {}
      const candidate = resolve(last?.[target]);
      id = candidate && palettes[candidate][0] === target ? candidate
        : stored ? palettes[stored][5]
        : target === "dark" ? "night" : "jade";
    }
    const [themeMode, page, text, accent, foreground] = palettes[id];
    const root = document.documentElement;
    root.dataset.theme = id;
    root.dataset.themeMode = themeMode;
    root.style.colorScheme = themeMode;
    root.style.setProperty("--theme-page", page);
    root.style.setProperty("--theme-text", text);
    root.style.setProperty("--theme-accent", accent);
    root.style.setProperty("--accent-fg", foreground);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", page);
  })();`;
}
