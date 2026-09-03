import { isTauriRuntime } from "./runtime";
import { Capacitor } from "@capacitor/core";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

export const DEFAULT_RELAY_URL = "wss://oneapi.zaiwenai.com/miniq-relay/ws";
const STORAGE_KEY = "miniq.remote.credentials.v1";
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

export function readRemoteCredentials(): RemoteCredentials | null {
  if (!isRemoteBrowserEntry()) return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as RemoteCredentials | null;
    if (!parsed?.apiKey || !parsed.relayUrl || !parsed.deviceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function loadRemoteCredentials(): Promise<RemoteCredentials | null> {
  const current = readRemoteCredentials();
  if (current || !Capacitor.isNativePlatform()) return current;
  try {
    const keys = await SecureStoragePlugin.keys();
    if (!keys.value.includes(NATIVE_STORAGE_KEY)) return null;
    const stored = await SecureStoragePlugin.get({ key: NATIVE_STORAGE_KEY });
    const parsed = JSON.parse(stored.value) as RemoteCredentials;
    if (!parsed?.apiKey || !parsed.relayUrl || !parsed.deviceId) return null;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    return parsed;
  } catch {
    return null;
  }
}

export async function storeRemoteCredentials(value: Omit<RemoteCredentials, "deviceId">): Promise<RemoteCredentials> {
  const credentials = { ...value, deviceId: readDeviceId() };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  if (Capacitor.isNativePlatform()) {
    await SecureStoragePlugin.set({ key: NATIVE_STORAGE_KEY, value: JSON.stringify(credentials) });
  }
  return credentials;
}

export async function clearRemoteCredentials(): Promise<void> {
  window.sessionStorage.removeItem(STORAGE_KEY);
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

function readDeviceId(): string {
  const key = "miniq.remote.deviceId.v1";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = `mobile-${crypto.randomUUID()}`;
  window.localStorage.setItem(key, created);
  return created;
}
