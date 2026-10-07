import { Capacitor, CapacitorHttp } from "@capacitor/core";

/** Android builds ship outside an app store, so updates are discovered by
 * comparing the local versionName against the public release manifest. */
export const RELEASE_MANIFEST_URL = "https://oss.zaiwen.top/releases/manifest.json";
export const MOBILE_DOWNLOAD_PAGE_URL = "https://chat.zaiwenai.com/download";
const UPDATE_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MESSAGE = "连接更新服务超时，请检查网络后重试，或前往下载页获取最新版。";

class UpdateRequestError extends Error {}

export interface AndroidRelease {
  version: string;
  url: string;
  releaseDate?: string;
  fileSize?: number;
  minAndroidVersion?: string;
  installationNotes: string[];
  releaseNotes?: string[];
  sha256?: string;
}

export type MobileUpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "unavailable"; version: string }
  | { phase: "available"; release: AndroidRelease }
  | { phase: "error"; error: string };

export function isMobileUpdateSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

/** Android versionName uses two to four numeric segments, with an optional v. */
export function isReleaseVersion(value: string): boolean {
  return /^v?\d+(?:\.\d+){1,3}$/i.test(value.trim()) &&
    value.trim().replace(/^v/i, "").split(".").every((part) => Number.isSafeInteger(Number(part)));
}

export function compareVersions(a: string, b: string): number {
  if (!isReleaseVersion(a) || !isReleaseVersion(b)) throw new Error("版本号格式无效");
  const parts = (value: string) => value.trim().replace(/^v/i, "").split(".").map(Number);
  const left = parts(a), right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function isOfficialAndroidApk(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://oss.zaiwen.top" && !url.username && !url.password &&
      !url.search && !url.hash && /^\/releases\/miniq\/android\/v[0-9.]+\/[A-Za-z0-9_.-]+\.apk$/.test(url.pathname);
  } catch { return false; }
}

export function parseAndroidRelease(manifest: unknown): AndroidRelease | null {
  const entry = (manifest as { products?: { miniq?: { platforms?: { android?: Record<string, unknown> } } } })
    ?.products?.miniq?.platforms?.android;
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.status !== "available") return null;
  const version = typeof entry.version === "string" ? entry.version.trim() : "";
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (!isReleaseVersion(version) || !isOfficialAndroidApk(url)) return null;
  if (entry.sha256 !== undefined && (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256))) return null;
  if (entry.fileSize !== undefined && (typeof entry.fileSize !== "number" || !Number.isSafeInteger(entry.fileSize) || entry.fileSize <= 0)) return null;
  if (entry.releaseNotes !== undefined && (!Array.isArray(entry.releaseNotes) || !entry.releaseNotes.every((note) => typeof note === "string"))) return null;
  if (entry.installationNotes !== undefined && (!Array.isArray(entry.installationNotes) || !entry.installationNotes.every((note) => typeof note === "string"))) return null;
  return {
    version, url,
    sha256: entry.sha256 as string | undefined,
    releaseDate: typeof entry.releaseDate === "string" ? entry.releaseDate : undefined,
    fileSize: entry.fileSize as number | undefined,
    minAndroidVersion: typeof entry.minAndroidVersion === "string" ? entry.minAndroidVersion : undefined,
    ...(entry.releaseNotes === undefined ? {} : { releaseNotes: (entry.releaseNotes as string[]).map((note) => note.trim()).filter(Boolean) }),
    installationNotes: (entry.installationNotes as string[] | undefined) ?? [],
  };
}

export async function readInstalledVersion(): Promise<string | null> {
  if (!isMobileUpdateSupported()) return null;
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    return isReleaseVersion(info.version) ? info.version : null;
  } catch {
    return null;
  }
}

export async function fetchAndroidRelease(
  fetchImpl: typeof fetch = fetch,
  url: string = RELEASE_MANIFEST_URL,
): Promise<AndroidRelease> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("release_check", String(Date.now()));
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new UpdateRequestError(UPDATE_TIMEOUT_MESSAGE));
      controller.abort();
    }, UPDATE_TIMEOUT_MS);
  });
  try {
    const manifest = await Promise.race([
      requestReleaseManifest(requestUrl.href, fetchImpl, controller.signal),
      deadline,
    ]);
    const release = parseAndroidRelease(manifest);
    if (!release) throw new UpdateRequestError("更新服务返回的发布信息不完整，请稍后重试。");
    return release;
  } catch (error) {
    if (error instanceof UpdateRequestError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|timed out/i.test(message)) throw new UpdateRequestError(UPDATE_TIMEOUT_MESSAGE);
    if (error instanceof SyntaxError) throw new UpdateRequestError("更新服务返回的发布信息不完整，请稍后重试。");
    throw new UpdateRequestError("无法连接更新服务，请检查网络后重试，或前往下载页获取最新版。");
  } finally {
    clearTimeout(timeout);
  }
}

async function requestReleaseManifest(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<unknown> {
  if (isMobileUpdateSupported()) {
    // The APK runs at https://localhost. Native HTTP avoids WebView CORS and
    // CDN preflight failures without patching fetch used by streaming chat.
    const response = await CapacitorHttp.get({
      url,
      responseType: "json",
      connectTimeout: UPDATE_TIMEOUT_MS,
      readTimeout: UPDATE_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new UpdateRequestError(`发布清单请求失败（HTTP ${response.status}），请稍后重试。`);
    }
    return typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  }
  const response = await fetchImpl(url, { cache: "no-store", credentials: "omit", signal });
  if (!response.ok) throw new UpdateRequestError(`发布清单请求失败（HTTP ${response.status}），请稍后重试。`);
  return response.json();
}

export async function checkAndroidUpdate(options: {
  currentVersion?: string | null;
  fetchImpl?: typeof fetch;
  manifestUrl?: string;
} = {}): Promise<MobileUpdateState> {
  if (!isMobileUpdateSupported()) return { phase: "idle" };
  const current = options.currentVersion ?? (await readInstalledVersion());
  if (!current || !isReleaseVersion(current)) return { phase: "error", error: "无法读取当前版本号" };
  const release = await fetchAndroidRelease(options.fetchImpl ?? fetch, options.manifestUrl ?? RELEASE_MANIFEST_URL);
  if (compareVersions(release.version, current) <= 0) {
    return { phase: "unavailable", version: current };
  }
  return { phase: "available", release };
}

export function formatFileSize(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}
