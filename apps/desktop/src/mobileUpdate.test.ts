import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkAndroidUpdate,
  compareVersions,
  fetchAndroidRelease,
  isMobileUpdateSupported,
  parseAndroidRelease,
  RELEASE_MANIFEST_URL,
} from "./mobileUpdate";

const { native, platform, nativeGet, appInfo } = vi.hoisted(() => ({
  native: vi.fn(), platform: vi.fn(), nativeGet: vi.fn(), appInfo: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: native, getPlatform: platform },
  CapacitorHttp: { get: nativeGet },
}));
vi.mock("@capacitor/app", () => ({ App: { getInfo: appInfo } }));

const release = {
  status: "available", version: "0.1.23", url: "https://oss.zaiwen.top/releases/miniq/android/v0.1.23/miniQ_0.1.23_android.apk",
  installationNotes: ["下载后安装即可保留设置。"],
};
const manifest = { products: { miniq: { platforms: { android: release } } } };
const nativeResponse = (data: unknown = manifest, status = 200) => ({ status, data, headers: {}, url: RELEASE_MANIFEST_URL });

beforeEach(() => {
  vi.resetAllMocks();
  native.mockReturnValue(true);
  platform.mockReturnValue("android");
  nativeGet.mockResolvedValue(nativeResponse());
  appInfo.mockResolvedValue({ version: "0.1.22" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Android update transport", () => {
  it("uses native HTTP for APK updates, so missing CDN CORS headers cannot block the check", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetcher);
    const result = await checkAndroidUpdate();
    expect(result).toMatchObject({ phase: "available", release: { version: "0.1.23", url: release.url } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(nativeGet).toHaveBeenCalledWith({
      url: expect.stringMatching(/^https:\/\/oss\.zaiwen\.top\/releases\/manifest\.json\?release_check=\d+$/),
      responseType: "json", connectTimeout: 15_000, readTimeout: 15_000,
    });
  });

  it("preserves manifest query parameters while bypassing stale CDN entries", async () => {
    await fetchAndroidRelease(fetch, `${RELEASE_MANIFEST_URL}?channel=android&release_check=old`);
    const url = new URL(nativeGet.mock.calls[0][0].url);
    expect(url.searchParams.get("channel")).toBe("android");
    expect(url.searchParams.getAll("release_check")).toHaveLength(1);
    expect(url.searchParams.get("release_check")).not.toBe("old");
  });

  it("keeps browser requests credential-free and avoids headers that require a CORS preflight", async () => {
    native.mockReturnValue(false);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(manifest)));
    await expect(fetchAndroidRelease(fetcher)).resolves.toMatchObject({ version: "0.1.23" });
    expect(nativeGet).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), {
      cache: "no-store", credentials: "omit", signal: expect.any(AbortSignal),
    });
  });

  it.each([true, false])("reports an HTTP error rather than claiming the APK is current (native=%s)", async (isNative) => {
    native.mockReturnValue(isNative);
    nativeGet.mockResolvedValue(nativeResponse({}, 503));
    const fetcher = vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 }));
    await expect(checkAndroidUpdate({ currentVersion: "0.1.22", fetchImpl: fetcher })).rejects.toThrow("HTTP 503");
  });

  it.each([true, false])("gives a Chinese recovery message for network failures (native=%s)", async (isNative) => {
    native.mockReturnValue(isNative);
    nativeGet.mockRejectedValue(new Error("Unable to resolve host"));
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchAndroidRelease(fetcher)).rejects.toThrow("无法连接更新服务，请检查网络后重试，或前往下载页获取最新版。");
  });

  it.each([true, false])("rejects malformed JSON instead of showing no update (native=%s)", async (isNative) => {
    native.mockReturnValue(isNative);
    nativeGet.mockResolvedValue(nativeResponse("{\"products\":"));
    const fetcher = vi.fn().mockResolvedValue(new Response("{\"products\":"));
    await expect(fetchAndroidRelease(fetcher)).rejects.toThrow("发布信息不完整");
  });

  it("translates native connection timeouts", async () => {
    nativeGet.mockRejectedValue(new Error("java.net.SocketTimeoutException: timeout"));
    await expect(fetchAndroidRelease()).rejects.toThrow("连接更新服务超时");
  });

  it.each([true, false])("bounds a stalled request and releases the deadline timer (native=%s)", async (isNative) => {
    vi.useFakeTimers();
    native.mockReturnValue(isNative);
    nativeGet.mockReturnValue(new Promise(() => {}));
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    const result = expect(fetchAndroidRelease(fetcher)).rejects.toThrow("连接更新服务超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    if (!isNative) expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a successful request", async () => {
    vi.useFakeTimers();
    await fetchAndroidRelease();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Android release selection", () => {
  it.each(["0.1.23", "0.1.24"])("does not offer a downgrade to installed version %s", async (currentVersion) => {
    await expect(checkAndroidUpdate({ currentVersion })).resolves.toEqual({ phase: "unavailable", version: currentVersion });
  });

  it("does not claim the client is current when its installed version cannot be read", async () => {
    appInfo.mockRejectedValue(new Error("App unavailable"));
    await expect(checkAndroidUpdate()).resolves.toEqual({ phase: "error", error: "无法读取当前版本号" });
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it.each(["ios", "web"])("does not enable the APK updater on %s", (value) => {
    platform.mockReturnValue(value);
    expect(isMobileUpdateSupported()).toBe(false);
  });

  it.each([{ ...release, status: "draft" }, { ...release, url: "http://example.com/untrusted.apk" }])(
    "ignores unpublished or insecure APK links", (android) => {
      expect(parseAndroidRelease({ products: { miniq: { platforms: { android } } } })).toBeNull();
    },
  );

  it("compares numeric version segments", () => {
    expect(compareVersions("0.1.23", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.1.23", "0.1.23")).toBe(0);
  });
});
