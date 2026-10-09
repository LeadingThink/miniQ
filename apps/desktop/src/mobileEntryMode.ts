export type MobileEntryMode = "chat" | "remote";
const STORAGE_KEY = "miniq.mobile.entryMode.v1";

export function readMobileEntryMode(): MobileEntryMode | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "chat" || value === "remote" ? value : null;
  } catch { return null; }
}

export function storeMobileEntryMode(mode: MobileEntryMode): void {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* Mode memory is optional. */ }
}
