// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ request: vi.fn(), keys: vi.fn(), get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true }, CapacitorHttp: { request: native.request }, CapacitorCookies: {} }));
vi.mock("capacitor-secure-storage-plugin", () => ({ SecureStoragePlugin: native }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  vi.stubEnv("VITE_MINIQ_API_BASE_URL", "");
});
afterEach(() => vi.unstubAllEnvs());
it("defaults to the production service and preserves production credential storage", async () => {
  const config = await import("./mobileApiConfig");
  expect(config.MOBILE_API_BASE_URL).toBe("https://oneapi.zaiwenai.com/v1");
  expect(config.IS_MOBILE_TEST_API).toBe(false);
  expect(config.mobileCredentialStorageKey("miniq.remote.credentials")).toBe("miniq.remote.credentials");
});
it("routes account requests to staging with a single /v1 prefix", async () => {
  vi.stubEnv("VITE_MINIQ_API_BASE_URL", "https://apidev.zaiask.com/v1/");
  native.request.mockResolvedValue({ status: 200, data: { code: "0", data: { phone: "13800000000", nick: "Test", balance: 0 } } });
  const config = await import("./mobileApiConfig");
  const { loadOneApiAccount } = await import("./mobileIapAccount");
  await loadOneApiAccount();
  expect(config.MOBILE_API_BASE_URL).toBe("https://apidev.zaiask.com/v1");
  expect(config.IS_MOBILE_TEST_API).toBe(true);
  expect(native.request).toHaveBeenCalledWith(expect.objectContaining({ url: "https://apidev.zaiask.com/v1/user" }));
});
it("does not load a saved production API Key into the staging build", async () => {
  vi.stubEnv("VITE_MINIQ_API_BASE_URL", "https://apidev.zaiask.com/v1");
  const previous = JSON.stringify({ apiKey: "sk-production", deviceId: "prod-device" });
  sessionStorage.setItem("miniq.remote.credentials.v1", previous);
  native.keys.mockResolvedValue({ value: ["miniq.remote.credentials"] });
  const { loadRemoteCredentials } = await import("./remoteAccess");
  expect(await loadRemoteCredentials()).toBeNull();
  expect(native.get).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("miniq.remote.credentials.v1")).toBe(previous);
});
it("stores and clears the staging Key without overwriting production credentials", async () => {
  vi.stubEnv("VITE_MINIQ_API_BASE_URL", "https://apidev.zaiask.com/v1");
  const { mobileCredentialStorageKey } = await import("./mobileApiConfig");
  const key = mobileCredentialStorageKey("miniq.remote.credentials");
  native.keys.mockResolvedValue({ value: ["miniq.remote.credentials", key] });
  native.set.mockResolvedValue(undefined); native.remove.mockResolvedValue(undefined);
  const { storeRemoteCredentials, clearRemoteCredentials } = await import("./remoteAccess");
  await storeRemoteCredentials({ apiKey: "sk-test-only", deviceName: "测试机" });
  expect(native.set).toHaveBeenCalledWith(expect.objectContaining({ key }));
  await clearRemoteCredentials();
  expect(native.remove).toHaveBeenCalledExactlyOnceWith({ key });
});
