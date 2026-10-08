import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkAndroidUpdate,
  checkMobileUpdate,
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
    await expect(fetchAndroidRelease(fetcher)).rejects.toThrow("HTTP 503");
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

  it.each(["web"])("does not enable the updater on %s", (value) => {
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

describe("strict Android manifest validation", () => {
  it.each([{ version: "latest" }, { version: "1.2.3oops" }, { version: "9007199254740993.1" },
    { status: undefined }, { status: "draft" }, { url: "https://evil.example/app.apk" },
    { url: "https://user:pass@oss.zaiwen.top/releases/miniq/android/v1.2/app.apk" },
    { url: release.url + "?redirect=evil" }, { url: release.url.replace(".apk", ".exe") },
    { fileSize: -1 }, { fileSize: Infinity }, { sha256: "bad" }, { installationNotes: [42] }])("rejects malformed release %j", (patch) => {
    expect(parseAndroidRelease({ products: { miniq: { platforms: { android: { ...release, ...patch } } } } })).toBeNull();
  });
  it("reports invalid data instead of a false current result", async () => {
    nativeGet.mockResolvedValue(nativeResponse({}));
    await expect(checkAndroidUpdate()).rejects.toThrow("发布信息不完整");
  });
  it.each(["ios", "web"])("never checks on %s even with an injected version", async (value) => {
    platform.mockReturnValue(value);
    expect(await checkAndroidUpdate({ currentVersion: "1.0" })).toEqual({ phase: "idle" });
    expect(nativeGet).not.toHaveBeenCalled(); expect(appInfo).not.toHaveBeenCalled();
  });
  it("uses APK versionName independent of product version", async () => {
    appInfo.mockResolvedValue({ version: "0.1.22" });
    nativeGet.mockResolvedValue(nativeResponse({ products: { miniq: { version: "9.9.9", platforms: { android: release } } } }));
    expect(await checkAndroidUpdate()).toMatchObject({ phase: "available", release: { version: "0.1.23" } });
    expect(appInfo).toHaveBeenCalledOnce();
  });
  it.each([["1.10", "1.9", 1], ["v1.2", "1.2.0.0", 0], ["1.2.3", "2.0", -1]])("compares %s to %s", (a, b, result) => {
    expect(compareVersions(a as string, b as string)).toBe(result);
  });
  it("rejects malformed installed version", async () => {
    appInfo.mockResolvedValue({ version: "latest" });
    expect(await checkAndroidUpdate()).toMatchObject({ phase: "error" }); expect(nativeGet).not.toHaveBeenCalled();
  });
});

describe("optional Android release notes", () => {
  const manifest = (patch: object) => ({ products: { miniq: { platforms: { android: { ...release, ...patch } } } } });
  it("accepts existing manifests without releaseNotes", () => {
    expect(parseAndroidRelease(manifest({}))?.releaseNotes).toBeUndefined();
  });
  it("normalizes string array notes while keeping installation notes separate", () => {
    const parsed = parseAndroidRelease(manifest({ releaseNotes: [" 新增功能 ", "", "  ", "体验优化"] }));
    expect(parsed?.releaseNotes).toEqual(["新增功能", "体验优化"]);
    expect(parsed?.installationNotes).toEqual(release.installationNotes);
  });
  it.each([null, "not an array", [42], ["valid", {}]])("rejects invalid notes %j", (releaseNotes) => {
    expect(parseAndroidRelease(manifest({ releaseNotes }))).toBeNull();
  });
});

describe("mobile platform dispatch", () => {
  it("supports iOS and compares installed marketing version, not build", async () => {
    platform.mockReturnValue("ios"); expect(isMobileUpdateSupported()).toBe(true);
    appInfo.mockResolvedValue({ version: "1.0", build: "999" });
    nativeGet.mockResolvedValue(nativeResponse({ resultCount: 1, results: [{ trackId: 6811485613, bundleId: "com.leadingthink.miniq", version: "1.1", trackViewUrl: "https://apps.apple.com/cn/app/id6811485613" }] }));
    expect(await checkMobileUpdate()).toMatchObject({ phase: "available", release: { platform: "ios", version: "1.1" } });
    expect(appInfo).toHaveBeenCalledOnce();
  });
  it.each(["1.1", "1.2"])("never downgrades installed iOS %s", async (version) => {
    platform.mockReturnValue("ios"); appInfo.mockResolvedValue({ version });
    nativeGet.mockResolvedValue(nativeResponse({ resultCount: 1, results: [{ trackId: 6811485613, bundleId: "com.leadingthink.miniq", version: "1.1", trackViewUrl: "https://apps.apple.com/cn/app/id6811485613" }] }));
    expect(await checkMobileUpdate()).toEqual({ phase: "unavailable", version });
  });
  it("dispatches Android compatibly", async () => {
    expect(await checkMobileUpdate()).toMatchObject({ phase: "available", release: { version: "0.1.23" } });
  });
  it("skips web without reading app information", async () => {
    native.mockReturnValue(false); expect(await checkMobileUpdate()).toEqual({ phase: "idle" });
    expect(appInfo).not.toHaveBeenCalled(); expect(nativeGet).not.toHaveBeenCalled();
  });
  it("reports missing iOS public listing as failure", async () => {
    platform.mockReturnValue("ios"); nativeGet.mockResolvedValue(nativeResponse({ resultCount: 0, results: [] }));
    await expect(checkMobileUpdate()).rejects.toThrow();
  });
});
