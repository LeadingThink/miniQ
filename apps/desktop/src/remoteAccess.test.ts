// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRemoteCredentials,
  DEFAULT_RELAY_URL,
  readRemoteCredentials,
  storeRemoteCredentials,
} from "./remoteAccess";

const native = vi.hoisted(() => vi.fn(() => false));
const secureSet = vi.hoisted(() => vi.fn());
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: native } }));
vi.mock("capacitor-secure-storage-plugin", () => ({
  SecureStoragePlugin: { set: secureSet },
}));

beforeEach(() => {
  native.mockReturnValue(false);
  secureSet.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

it("removes remembered remote credentials without deleting unrelated chat history", async () => {
  sessionStorage.setItem("miniq.remote.credentials.v1", "session");
  localStorage.setItem("miniq.remote.credentials.persist.v1", "persisted");
  localStorage.setItem("miniq.remote.remember.v1", "1");
  localStorage.setItem("miniq.remote.deviceId.v1", "stable-device");
  localStorage.setItem("miniq.mobile.chat.v1", "conversation");

  await clearRemoteCredentials();

  expect(sessionStorage.getItem("miniq.remote.credentials.v1")).toBeNull();
  expect(localStorage.getItem("miniq.remote.credentials.persist.v1")).toBeNull();
  expect(localStorage.getItem("miniq.remote.remember.v1")).toBeNull();
  expect(localStorage.getItem("miniq.remote.deviceId.v1")).toBe("stable-device");
  expect(localStorage.getItem("miniq.mobile.chat.v1")).toBe("conversation");
});

it("migrates old remote credentials to the fixed official relay", () => {
  sessionStorage.setItem("miniq.remote.credentials.v1", JSON.stringify({
    apiKey: "sk-old",
    relayUrl: "wss://custom.example/ws",
    deviceId: "mobile-old",
    deviceName: "旧设备",
  }));

  expect(readRemoteCredentials()).toEqual({
    apiKey: "sk-old",
    relayUrl: DEFAULT_RELAY_URL,
    deviceId: "mobile-old",
    deviceName: "旧设备",
  });
});

it("always stores the fixed official relay", async () => {
  const stored = await storeRemoteCredentials({
    apiKey: "sk-new",
    deviceName: "新设备",
  });

  expect(stored.relayUrl).toBe(DEFAULT_RELAY_URL);
  expect(readRemoteCredentials()?.relayUrl).toBe(DEFAULT_RELAY_URL);
});

describe("native credential storage", () => {
  const sessionKey = "miniq.remote.credentials.v1";
  const previous = {
    apiKey: "sk-old",
    relayUrl: DEFAULT_RELAY_URL,
    deviceId: "stable-device",
    deviceName: "旧设备",
  };
  const replacement = { apiKey: "sk-new", deviceName: "新设备" };

  beforeEach(() => {
    native.mockReturnValue(true);
    localStorage.setItem("miniq.remote.deviceId.v1", previous.deviceId);
    sessionStorage.setItem(sessionKey, JSON.stringify(previous));
  });

  it("keeps the previous session credentials while secure storage is pending", async () => {
    let resolve!: () => void;
    secureSet.mockReturnValue(new Promise<void>((done) => { resolve = done; }));

    const storing = storeRemoteCredentials(replacement);

    expect(secureSet).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(sessionKey)).toBe(JSON.stringify(previous));
    expect(readRemoteCredentials()).toEqual(previous);

    resolve();
    await storing;
  });

  it("keeps the previous session credentials when secure storage fails", async () => {
    const error = new Error("Secure storage unavailable");
    secureSet.mockRejectedValue(error);

    await expect(storeRemoteCredentials(replacement)).rejects.toBe(error);

    expect(sessionStorage.getItem(sessionKey)).toBe(JSON.stringify(previous));
    expect(readRemoteCredentials()).toEqual(previous);
  });

  it("updates the session credentials after secure storage succeeds", async () => {
    secureSet.mockResolvedValue({ value: true });

    const stored = await storeRemoteCredentials(replacement);

    expect(stored).toEqual({ ...previous, ...replacement });
    expect(secureSet).toHaveBeenCalledExactlyOnceWith({
      key: "miniq.remote.credentials",
      value: JSON.stringify(stored),
    });
    expect(sessionStorage.getItem(sessionKey)).toBe(JSON.stringify(stored));
    expect(readRemoteCredentials()).toEqual(stored);
  });
});
