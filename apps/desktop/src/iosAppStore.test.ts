import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchIosAppStoreRelease, IOS_APP_STORE_URL, isOfficialIosAppStoreUrl, parseIosAppStoreRelease } from "./iosAppStore";
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@capacitor/core", () => ({ CapacitorHttp: { get } }));
const entry = { trackId: 6811485613, bundleId: "com.leadingthink.miniq", version: "1.2", trackViewUrl: "https://apps.apple.com/cn/app/miniq/id6811485613?uo=4", releaseNotes: " 新功能\n修复问题 " };
const payload = (patch = {}) => ({ resultCount: 1, results: [{ ...entry, ...patch }] });
beforeEach(() => { get.mockReset(); });
afterEach(() => vi.useRealTimers());
it("validates a public listing and returns an iOS release", () => {
  expect(parseIosAppStoreRelease(payload())).toMatchObject({ platform: "ios", version: "1.2", url: IOS_APP_STORE_URL, installationNotes: [], releaseNotes: ["新功能", "修复问题"] });
});
it.each([{ trackId: "6811485613" }, { trackId: 123 }, { bundleId: "other" }, { version: "latest" }, { version: "v1.2" }, { version: "1.2beta" }, { version: "1.2.3.4" }, { version: "9007199254740993.1" }, { trackViewUrl: "https://apps.apple.com/cn/app/id123" }, { releaseNotes: 42 }])("rejects mismatched or malformed public listings %j", (patch) => {
  expect(parseIosAppStoreRelease(payload(patch))).toBeNull();
});
it.each([null, {}, { resultCount: 0, results: [] }, { resultCount: 1, results: [] }, { resultCount: 2, results: [entry, entry] }])("does not interpret missing listing as current %j", (data) => {
  expect(parseIosAppStoreRelease(data)).toBeNull();
});
it.each([IOS_APP_STORE_URL, entry.trackViewUrl, "https://apps.apple.com/us/app/id6811485613"])("accepts this app's Apple URL %s", (url) => expect(isOfficialIosAppStoreUrl(url)).toBe(true));
it.each(["https://apps.apple.com.evil.com/cn/app/id6811485613", "http://apps.apple.com/cn/app/id6811485613", "https://user@apps.apple.com/cn/app/id6811485613", "https://apps.apple.com/cn/app/id68114856130", "https://apps.apple.com/cn/app/id6811485613/other", IOS_APP_STORE_URL + "?redirect=https://evil.com", IOS_APP_STORE_URL + "#evil", "itms-apps://apps.apple.com/cn/app/id6811485613"])("rejects unsafe destination %s", (url) => expect(isOfficialIosAppStoreUrl(url)).toBe(false));
it.each([false, true])("uses native HTTP and explicitly checks China storefront (string=%s)", async (string) => {
  get.mockResolvedValue({ status: 200, data: string ? JSON.stringify(payload()) : payload() });
  await expect(fetchIosAppStoreRelease()).resolves.toMatchObject({ platform: "ios" });
  expect(get).toHaveBeenCalledWith({ url: "https://itunes.apple.com/lookup?id=6811485613&country=cn", responseType: "json", connectTimeout: 15000, readTimeout: 15000 });
});
it.each([{ status: 503, data: payload() }, { status: 200, data: { resultCount: 0, results: [] } }, { status: 200, data: "{" }])("fails closed for invalid service response %j", async (response) => {
  get.mockResolvedValue(response);
  await expect(fetchIosAppStoreRelease()).rejects.toThrow();
});
it("bounds a stalled native request and clears its timer", async () => {
  vi.useFakeTimers(); get.mockReturnValue(new Promise(() => {}));
  const result = expect(fetchIosAppStoreRelease()).rejects.toThrow("超时");
  await vi.advanceTimersByTimeAsync(15000); await result;
  expect(vi.getTimerCount()).toBe(0);
});
it("clears its deadline on success and contains native errors", async () => {
  vi.useFakeTimers(); get.mockResolvedValue({ status: 200, data: payload() });
  await fetchIosAppStoreRelease(); expect(vi.getTimerCount()).toBe(0);
  get.mockRejectedValue(new Error("network unavailable"));
  await expect(fetchIosAppStoreRelease()).rejects.toThrow("无法连接");
  expect(vi.getTimerCount()).toBe(0);
});
it("recovers from an intermittent native SSL failure on a later check", async () => {
  vi.useFakeTimers();
  get.mockResolvedValueOnce({ status: 200, data: payload() })
    .mockRejectedValueOnce(new Error("NSURLErrorDomain -1200: An SSL error has occurred"))
    .mockResolvedValueOnce({ status: 200, data: payload({ version: "1.3" }) });
  await expect(fetchIosAppStoreRelease()).resolves.toMatchObject({ version: "1.2" });
  await expect(fetchIosAppStoreRelease()).rejects.toThrow("无法连接 App Store");
  expect(vi.getTimerCount()).toBe(0);
  await expect(fetchIosAppStoreRelease()).resolves.toMatchObject({ version: "1.3", platform: "ios" });
  expect(get).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
