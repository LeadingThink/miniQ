import { getBackground, isBackgroundId, NO_BACKGROUND, type BackgroundDefinition } from "./backgroundCatalog";

export const BACKGROUND_STORAGE_KEY = "miniq.appearance.background";

let current: BackgroundDefinition | undefined;
const listeners = new Set<() => void>();

function readStored(): BackgroundDefinition {
  try {
    const value = window.localStorage.getItem(BACKGROUND_STORAGE_KEY);
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

function syncStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  if (event.key !== null && event.key !== BACKGROUND_STORAGE_KEY) return;
  current = readStored();
  applyBackground(current);
  notify();
}

export function subscribeBackground(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener("storage", syncStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", syncStorage);
  };
}

export function initializeBackground() {
  current = readStored();
  applyBackground(current);
}

export function storeBackground(id: string) {
  current = getBackground(id);
  try {
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, current.id);
  } catch {
    // Keep the in-memory preference usable in restricted webviews.
  }
  applyBackground(current);
  notify();
}
