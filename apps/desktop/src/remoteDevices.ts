/** UI device identity is separate from the phone's credential deviceId. */
export interface RemoteDesktop {
  id: string;
  name: string;
  online: boolean;
  lastSeen?: string;
}

const SELECTION_KEY = "miniq.remote.desktop.v1";

/** Scope is the derived room identity, never the API key. */
export function loadSelectedDesktop(scope: string): RemoteDesktop | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${SELECTION_KEY}:${scope}`) ?? "null");
    if (!value || typeof value !== "object") return null;
    const device = value as Partial<RemoteDesktop>;
    if (typeof device.id !== "string" || !device.id || typeof device.name !== "string") return null;
    // Stored presence is never evidence that a computer is currently online.
    return { id: device.id, name: device.name, online: false };
  } catch { return null; }
}

export function rememberSelectedDesktop(scope: string, device: RemoteDesktop): void {
  try { localStorage.setItem(`${SELECTION_KEY}:${scope}`, JSON.stringify({ id: device.id, name: device.name })); }
  catch { /* Selection remains usable when browser storage is unavailable. */ }
}

export function clearSelectedDesktop(scope: string): void {
  try { localStorage.removeItem(`${SELECTION_KEY}:${scope}`); } catch { /* Storage may be unavailable. */ }
}

/** Preserve an explicitly selected offline computer even if discovery omits it. */
export function desktopsWithSelection(devices: RemoteDesktop[], selected: RemoteDesktop | null): RemoteDesktop[] {
  const unique = new Map(devices.map((device) => [device.id, device]));
  if (selected && !unique.has(selected.id)) unique.set(selected.id, { ...selected, online: false });
  return [...unique.values()];
}
