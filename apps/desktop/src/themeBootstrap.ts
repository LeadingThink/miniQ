import { accentForeground, LEGACY_THEMES, THEMES, THEME_STORAGE_KEY } from "./theme";

// Vite embeds this from the same catalog, before CSS/React load, so every
// theme (including migrated IDs) has a matching first paint without a second catalog.
export function buildThemeBootstrap(): string {
  const palettes = Object.fromEntries(
    THEMES.map(({ id, mode, preview }) => [
      id,
      [mode, preview.page, preview.text, preview.accent, accentForeground(preview.accent)],
    ])
  );
  return `(() => {
    const palettes = ${JSON.stringify(palettes)};
    const aliases = ${JSON.stringify(LEGACY_THEMES)};
    let id;
    try { id = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}); } catch {}
    if (Object.hasOwn(aliases, id)) id = aliases[id];
    if (!Object.hasOwn(palettes, id)) id = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "night" : "jade";
    const [mode, page, text, accent, foreground] = palettes[id];
    const root = document.documentElement;
    root.dataset.theme = id;
    root.dataset.themeMode = mode;
    root.style.colorScheme = mode;
    root.style.setProperty("--theme-page", page);
    root.style.setProperty("--theme-text", text);
    root.style.setProperty("--theme-accent", accent);
    root.style.setProperty("--accent-fg", foreground);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", page);
  })();`;
}
