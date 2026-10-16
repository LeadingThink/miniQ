import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), deleteCookie: vi.fn(), invoke: vi.fn(), tauri: false }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => !mocks.tauri },
  CapacitorHttp: { request: mocks.request }, CapacitorCookies: { deleteCookie: mocks.deleteCookie },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => mocks.tauri }));
import { createOneApiKey, loadIapPurchaseContext, loadOneApiAccount, loadOneApiKeys, loginIapAccount, logoutIapAccount, oneApiRequest, requestIapLoginCode } from "./mobileIapAccount";
const success = (data?: unknown) => ({ status: 200, data: { code: "0", data } });
const account = { phone: "13800000000", nick: "Test", balance: 100.0001 };
const key = { key_id: "key-1", sk: "sk-test", remark: "miniQ", is_active: true, expire_time: 2000000000 };
beforeEach(() => { vi.resetAllMocks(); mocks.tauri = false; mocks.deleteCookie.mockResolvedValue(undefined); });

it("uses the Tauri account transport without putting cookies or JWTs in JS", async () => {
  mocks.tauri = true;
  mocks.invoke.mockResolvedValue({ status: 200, data: { code: "0", data: account } });
  expect(await loadOneApiAccount()).toEqual(account);
  expect(mocks.invoke).toHaveBeenCalledWith("desktop_account_request", {
    request: { baseUrl: "https://oneapi.zaiwenai.com/v1", path: "/user", method: "GET", body: null },
  });
  expect(mocks.request).not.toHaveBeenCalled();
});

it("logs out on desktop without calling the mobile cookie plugin", async () => {
  mocks.tauri = true;
  mocks.invoke.mockResolvedValue(success());
  await logoutIapAccount();
  expect(mocks.invoke).toHaveBeenCalledWith("desktop_account_request", expect.objectContaining({
    request: expect.objectContaining({ path: "/user/logout", method: "POST" }),
  }));
  expect(mocks.deleteCookie).not.toHaveBeenCalled();
});

it("uses native cookie requests and the real phone login schema, then validates the saved cookie via /user", async () => {
  mocks.request.mockResolvedValueOnce(success({ token: "secret-jwt" })).mockResolvedValueOnce(success(account));
  expect(await loginIapAccount(" 13800000000 ", " 123456 ")).toEqual(account);
  expect(mocks.request.mock.calls[0][0]).toMatchObject({
    url: "https://oneapi.zaiwenai.com/v1/user/login", method: "POST", data: { phone: "13800000000", code: "123456", inviteCode: "" }, disableRedirects: true,
  });
  expect(mocks.request.mock.calls[1][0]).toMatchObject({ url: "https://oneapi.zaiwenai.com/v1/user", method: "GET" });
  for (const [options] of mocks.request.mock.calls) {
    expect(options.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("secret-jwt");
  }
});
it("validates phone and code before sending SMS or login requests", async () => {
  await expect(requestIapLoginCode("+8613800000000")).rejects.toThrow("11 位");
  await expect(loginIapAccount("13800000000", "123")).rejects.toThrow("6 位");
  expect(mocks.request).not.toHaveBeenCalled();
});
it("uses the channel's actual SMS endpoint and request field", async () => {
  mocks.request.mockResolvedValue(success());
  await requestIapLoginCode("13800000000");
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
    url: "https://oneapi.zaiwenai.com/v1/user/sms",
    method: "POST",
    data: { phone: "13800000000" },
  }));
});
it("recognizes HTTP 200 login expiry and never presents server bodies containing secrets", async () => {
  mocks.request.mockResolvedValue({ status: 200, data: { code: "-2", msg: "secret" } });
  expect(await loadOneApiAccount()).toBeNull();
  await expect(oneApiRequest("/keys")).rejects.toMatchObject({ code: "-2" });
  mocks.request.mockResolvedValue({ status: 200, data: { code: "-1", msg: "sk-private-token" } });
  await expect(oneApiRequest("/keys")).rejects.toThrow("操作未完成");
});
it("reports failure when the login response did not establish a working cookie", async () => {
  mocks.request.mockResolvedValueOnce(success({ token: "unused" })).mockResolvedValueOnce({ status: 401, data: {} });
  await expect(loginIapAccount("13800000000", "123456")).rejects.toThrow("登录状态未保存");
});
it("creates a shared account key with all models and no per-key cap", async () => {
  mocks.request.mockResolvedValue(success(key));
  expect(await createOneApiKey(" miniQ ")).toEqual(key);
  expect(mocks.request.mock.calls[0][0].data).toEqual({ remark: "miniQ", is_active: true, allow_model_ids: ["all"], quote_limit: 0 });
});
it("preserves a full page of keys and supports subsequent pages", async () => {
  const keys = Array.from({ length: 10 }, (_, index) => ({ ...key, key_id: `key-${index}` }));
  mocks.request.mockResolvedValue(success({ total: 31, keys }));
  expect(await loadOneApiKeys(3)).toEqual({ total: 31, keys });
  expect(mocks.request.mock.calls[0][0].url).toBe("https://oneapi.zaiwenai.com/v1/keys?page=3&page_size=10");
});
it("logs out server-side before clearing the native login cookie", async () => {
  mocks.request.mockResolvedValue(success());
  await logoutIapAccount();
  expect(mocks.request.mock.calls[0][0].url).toBe("https://oneapi.zaiwenai.com/v1/user/logout");
  expect(mocks.deleteCookie).toHaveBeenCalledWith({ url: "https://oneapi.zaiwenai.com/v1", key: "token" });
});
it("rejects malformed account binding before any StoreKit purchase", async () => {
  mocks.request.mockResolvedValue(success({ accountId: "u1", appAccountToken: "invalid", environment: "Production" }));
  await expect(loadIapPurchaseContext()).rejects.toThrow("购买账户信息无效");
});
