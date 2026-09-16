// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  clearRemoteCredentials,
  DEFAULT_RELAY_URL,
  readRemoteCredentials,
  storeRemoteCredentials,
} from "./remoteAccess";

beforeEach(() => {
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
