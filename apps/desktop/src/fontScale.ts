export const FONT_SIZE_STORAGE_KEY = "miniq.appearance.fontSize";

export const FONT_SIZE_LIMITS = {
  min: 11,
  max: 20,
  default: 14,
} as const;

let current: number | undefined;
const listeners = new Set<() => void>();

function readStoredSize(): number {
  try {
    const value = Number(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY));
    return Number.isInteger(value) && value >= FONT_SIZE_LIMITS.min && value <= FONT_SIZE_LIMITS.max
      ? value
      : FONT_SIZE_LIMITS.default;
  } catch {
    return FONT_SIZE_LIMITS.default;
  }
}
function persist(size: number) {
  try {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(size));
  } catch {
    // Keep the in-memory preference usable in restricted webviews.
  }
}

function apply(size: number) {
  document.documentElement.style.setProperty("--interface-font-size", `${size}px`);
}

function notify() {
  listeners.forEach((listener) => listener());
}

function syncStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  if (event.key !== null && event.key !== FONT_SIZE_STORAGE_KEY) return;
  current = readStoredSize();
  apply(current);
  notify();
}

export function getFontSize(): number {
  return (current ??= readStoredSize());
}

export function initializeFontScale() {
  current = readStoredSize();
  apply(current);
  persist(current);
  if (!listeners.size) window.addEventListener("storage", syncStorage);
}

export function storeFontSize(value: number) {
  if (!Number.isInteger(value) || value < FONT_SIZE_LIMITS.min || value > FONT_SIZE_LIMITS.max) return;
  current = value;
  persist(current);
  apply(current);
  notify();
}

export function subscribeFontScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", syncStorage);
  };
}
