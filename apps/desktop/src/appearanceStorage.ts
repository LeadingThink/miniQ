import { isNativeMobileApp } from "./mobileRuntime";

export const BACKGROUND_STORAGE_KEY = "miniq.appearance.background";
export const ROTATION_STORAGE_KEY = "miniq.appearance.rotation";
export const APPEARANCE_MIGRATION_KEY = "miniq.appearance.wallpaperVersion";
export const WALLPAPER_CHANGE_EVENT = "miniq:wallpaper-change";
export const localAppearanceStorage = (): Storage | undefined => {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
};
const restrictedValues = new WeakMap<Storage, Map<string, string>>();
const unavailableValues = new Map<string, string>();
function memoryValues(storage: Storage | undefined): Map<string, string> {
  if (!storage) return unavailableValues;
  let values = restrictedValues.get(storage);
  if (!values) { values = new Map(); restrictedValues.set(storage, values); }
  return values;
}
export function writeAppearanceValue(storage: Storage | undefined, key: string, value: string) {
  const values = memoryValues(storage);
  try {
    if (!storage) throw new Error("Storage unavailable");
    storage.setItem(key, value);
    values.delete(key);
  } catch { values.set(key, value); }
}
export function readAppearanceValue(storage: Storage | undefined, key: string): string | null {
  const pending = memoryValues(storage).get(key);
  if (pending !== undefined) return pending;
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

/** Claim the shared keys once. Mobile's prior choices win only during migration. */
export function migrateWallpaperPreferences(storage = localAppearanceStorage(), mobile = isNativeMobileApp()) {
  if (readAppearanceValue(storage, APPEARANCE_MIGRATION_KEY) === "1") return;
  try {
    for (const [key, legacy, fallback] of [
      [BACKGROUND_STORAGE_KEY, "miniq.mobile.appearance.background", "none"],
      [ROTATION_STORAGE_KEY, "miniq.mobile.appearance.rotation", "null"],
    ]) {
      const value = (mobile ? readAppearanceValue(storage, legacy) : null) ?? readAppearanceValue(storage, key) ?? fallback;
      writeAppearanceValue(storage, key, value);
    }
    writeAppearanceValue(storage, APPEARANCE_MIGRATION_KEY, "1");
    storage?.removeItem("miniq.mobile.appearance.background");
    storage?.removeItem("miniq.mobile.appearance.rotation");
  } catch { /* Restricted webviews still support the live preference. */ }
}

export function notifyWallpaperChange(storage = localAppearanceStorage(), keys = [BACKGROUND_STORAGE_KEY, ROTATION_STORAGE_KEY]) {
  if (typeof window !== "undefined" && storage === localAppearanceStorage()) window.dispatchEvent(new CustomEvent(WALLPAPER_CHANGE_EVENT, { detail: keys }));
}
