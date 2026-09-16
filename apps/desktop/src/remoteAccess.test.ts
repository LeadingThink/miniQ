// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { clearRemoteCredentials } from "./remoteAccess";

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
