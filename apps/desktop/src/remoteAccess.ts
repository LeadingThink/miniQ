import { isTauriRuntime } from "./runtime";
import { Capacitor } from "@capacitor/core";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

export const DEFAULT_RELAY_URL = "wss://oneapi.zaiwenai.com/miniq-relay/ws";
const STORAGE_KEY = "miniq.remote.credentials.v1";
const PERSIST_KEY = "miniq.remote.credentials.persist.v1";
const REMEMBER_KEY = "miniq.remote.remember.v1";
const NATIVE_STORAGE_KEY = "miniq.remote.credentials";

export interface RemoteCredentials {
  apiKey: string;
  relayUrl: string;
  deviceId: string;
  deviceName: string;
}

export function isRemoteBrowserEntry(): boolean {
  if (isTauriRuntime()) return false;
  const query = new URLSearchParams(window.location.search);
  return !(Number(query.get("port")) && query.get("token"));
}

/** Native apps always remember the key; browsers only when the user opted in. */
export function isRememberEnabled(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  try {
    return window.localStorage.getItem(REMEMBER_KEY) === "1";
  } catch {
    return false;
  }
}

export function setRememberEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.setItem(REMEMBER_KEY, "1");
    } else {
      window.localStorage.removeItem(REMEMBER_KEY);
      window.localStorage.removeItem(PERSIST_KEY);
    }
  } catch {
    // Storage may be unavailable in private browsing; the session copy still works.
  }
}

function parseCredentials(raw: string | null): RemoteCredentials | null {
  try {
    const parsed = JSON.parse(raw ?? "null") as RemoteCredentials | null;
    if (!parsed?.apiKey || !parsed.relayUrl || !parsed.deviceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readRemoteCredentials(): RemoteCredentials | null {
  if (!isRemoteBrowserEntry()) return null;
  const session = parseCredentials(safeRead(window.sessionStorage, STORAGE_KEY));
  if (session) return session;
  if (!isRememberEnabled()) return null;
  const persisted = parseCredentials(safeRead(window.localStorage, PERSIST_KEY));
  if (persisted) {
    safeWrite(window.sessionStorage, STORAGE_KEY, JSON.stringify(persisted));
  }
  return persisted;
}

export async function loadRemoteCredentials(): Promise<RemoteCredentials | null> {
  const current = readRemoteCredentials();
  if (current || !Capacitor.isNativePlatform()) return current;
  try {
    const keys = await SecureStoragePlugin.keys();
    if (!keys.value.includes(NATIVE_STORAGE_KEY)) return null;
    const stored = await SecureStoragePlugin.get({ key: NATIVE_STORAGE_KEY });
    const parsed = parseCredentials(stored.value);
    if (!parsed) return null;
    safeWrite(window.sessionStorage, STORAGE_KEY, JSON.stringify(parsed));
    return parsed;
  } catch {
    return null;
  }
}

export async function storeRemoteCredentials(
  value: Omit<RemoteCredentials, "deviceId">,
  options: { remember?: boolean } = {},
): Promise<RemoteCredentials> {
  if (options.remember !== undefined && !Capacitor.isNativePlatform()) {
    setRememberEnabled(options.remember);
  }
  const credentials = { ...value, deviceId: readDeviceId() };
  const serialized = JSON.stringify(credentials);
  safeWrite(window.sessionStorage, STORAGE_KEY, serialized);
  if (Capacitor.isNativePlatform()) {
    await SecureStoragePlugin.set({ key: NATIVE_STORAGE_KEY, value: serialized });
  } else if (isRememberEnabled()) {
    safeWrite(window.localStorage, PERSIST_KEY, serialized);
  } else {
    safeRemove(window.localStorage, PERSIST_KEY);
  }
  return credentials;
}

export async function clearRemoteCredentials(): Promise<void> {
  safeRemove(window.sessionStorage, STORAGE_KEY);
  safeRemove(window.localStorage, PERSIST_KEY);
  if (Capacitor.isNativePlatform()) {
    try {
      const keys = await SecureStoragePlugin.keys();
      if (keys.value.includes(NATIVE_STORAGE_KEY)) {
        await SecureStoragePlugin.remove({ key: NATIVE_STORAGE_KEY });
      }
    } catch {
      // The web session is already cleared even if native storage is unavailable.
    }
  }
}

function safeRead(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore quota/private-mode failures.
  }
}

function safeRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Ignore quota/private-mode failures.
  }
}

function readDeviceId(): string {
  const key = "miniq.remote.deviceId.v1";
  const existing = safeRead(window.localStorage, key);
  if (existing) return existing;
  const created = `mobile-${crypto.randomUUID()}`;
  safeWrite(window.localStorage, key, created);
  return created;
}
