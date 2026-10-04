import { getBackground, isBackgroundId, NO_BACKGROUND, type BackgroundDefinition } from "./backgroundCatalog";

import { BACKGROUND_STORAGE_KEY, WALLPAPER_CHANGE_EVENT, localAppearanceStorage, readAppearanceValue, writeAppearanceValue, migrateWallpaperPreferences, notifyWallpaperChange } from "./appearanceStorage";
export { BACKGROUND_STORAGE_KEY } from "./appearanceStorage";

let current: BackgroundDefinition | undefined;
const listeners = new Set<() => void>();

function readStored(): BackgroundDefinition {
  migrateWallpaperPreferences();
  try {
    const value = readAppearanceValue(localAppearanceStorage(), BACKGROUND_STORAGE_KEY);
    return getBackground(isBackgroundId(value) ? value : NO_BACKGROUND);
  } catch {
    return getBackground(NO_BACKGROUND);
  }
}

/** Mirrors the active background on <html> so wallpaper-mode CSS can adapt surfaces. */
export function applyBackground(background: BackgroundDefinition) {
  const root = document.documentElement;
  if (background.kind === "none") {
    delete root.dataset.background;
    delete root.dataset.backgroundKind;
    delete root.dataset.backgroundTone;
    return;
  }
  root.dataset.background = background.id;
  root.dataset.backgroundKind = background.kind;
  root.dataset.backgroundTone = background.light ? "light" : "dark";
}

export function getActiveBackground(): BackgroundDefinition {
  return (current ??= readStored());
}

function notify() {
  listeners.forEach((listener) => listener());
}

function syncStorage(event: Event) {
  if (event instanceof StorageEvent) {
    if (event.storageArea && event.storageArea !== localAppearanceStorage()) return;
    if (event.key !== null && event.key !== BACKGROUND_STORAGE_KEY) return;
  }
  if (event instanceof CustomEvent && !event.detail.includes(BACKGROUND_STORAGE_KEY)) return;
  current = readStored();
  applyBackground(current);
  notify();
}

export function subscribeBackground(listener: () => void): () => void {
  if (!listeners.size) {
    current = readStored();
    applyBackground(current);
    window.addEventListener("storage", syncStorage);
    window.addEventListener(WALLPAPER_CHANGE_EVENT, syncStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("storage", syncStorage);
      window.removeEventListener(WALLPAPER_CHANGE_EVENT, syncStorage);
    }
  };
}

export function initializeBackground() {
  current = readStored();
  applyBackground(current);
}

export function storeBackground(id: string) {
  migrateWallpaperPreferences();
  current = getBackground(id);
  try {
    writeAppearanceValue(localAppearanceStorage(), BACKGROUND_STORAGE_KEY, current.id);
    notifyWallpaperChange(undefined, [BACKGROUND_STORAGE_KEY]);
  } catch {
    // Keep the in-memory preference usable in restricted webviews.
  }
  applyBackground(current);
  notify();
}
