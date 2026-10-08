import { CapacitorHttp } from "@capacitor/core";
import type { AndroidRelease } from "./mobileUpdate";

/** Public App Store listing (README / docs) and capacitor appId. */
export const IOS_APP_STORE_ID = 6811485613;
export const IOS_BUNDLE_ID = "com.leadingthink.miniq";
export const IOS_APP_STORE_URL = `https://apps.apple.com/cn/app/id${IOS_APP_STORE_ID}`;
const LOOKUP_URL = `https://itunes.apple.com/lookup?id=${IOS_APP_STORE_ID}&country=cn`;
const LISTING_PATH = new RegExp(`^/(?:[a-z]{2}/)?app/(?:[^/]+/)?id${IOS_APP_STORE_ID}$`);
const TIMEOUT_MS = 15_000;
const TIMEOUT_MESSAGE = "连接 App Store 超时，请检查网络后重试。";
class AppStoreRequestError extends Error {}

/** Apple marketing versions have two or three numeric components. */
export function isIosReleaseVersion(value: string): boolean {
  return /^\d+(?:\.\d+){1,2}$/.test(value) &&
    value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

/** Only this app, on Apple's HTTPS store. Lookup commonly adds ?uo=4. */
export function isOfficialIosAppStoreUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://apps.apple.com" && !url.username && !url.password &&
      !url.hash && (!url.search || url.search === "?uo=4") &&
      LISTING_PATH.test(url.pathname);
  } catch { return false; }
}

export function parseIosAppStoreRelease(data: unknown): AndroidRelease | null {
  if (!data || typeof data !== "object") return null;
  const { resultCount, results } = data as { resultCount?: unknown; results?: unknown };
  if (resultCount !== 1 || !Array.isArray(results) || results.length !== 1) return null;
  const entry = results[0];
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
    entry.trackId !== IOS_APP_STORE_ID || entry.bundleId !== IOS_BUNDLE_ID ||
    typeof entry.version !== "string" || !isIosReleaseVersion(entry.version) ||
    typeof entry.trackViewUrl !== "string" || !isOfficialIosAppStoreUrl(entry.trackViewUrl) ||
    (entry.releaseNotes !== undefined && typeof entry.releaseNotes !== "string")) return null;
  return {
    platform: "ios", version: entry.version, url: IOS_APP_STORE_URL, installationNotes: [],
    ...(typeof entry.currentVersionReleaseDate === "string" ? { releaseDate: entry.currentVersionReleaseDate } : {}),
    ...(typeof entry.releaseNotes === "string" ? { releaseNotes: entry.releaseNotes.split(/\r?\n/).map((note: string) => note.trim()).filter(Boolean) } : {}),
  };
}

/** Zero lookup results mean publication cannot be verified in China, not up-to-date. */
export async function fetchIosAppStoreRelease(): Promise<AndroidRelease> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      CapacitorHttp.get({ url: LOOKUP_URL, responseType: "json", connectTimeout: TIMEOUT_MS, readTimeout: TIMEOUT_MS }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppStoreRequestError(TIMEOUT_MESSAGE)), TIMEOUT_MS);
      }),
    ]);
    if (response.status < 200 || response.status >= 300) {
      throw new AppStoreRequestError(`App Store 查询失败（HTTP ${response.status}），请稍后重试。`);
    }
    const release = parseIosAppStoreRelease(typeof response.data === "string" ? JSON.parse(response.data) : response.data);
    if (!release) throw new AppStoreRequestError("无法确认中国区 App Store 的公开上架版本，请稍后重试或前往 App Store 查看。");
    return release;
  } catch (error) {
    if (error instanceof AppStoreRequestError) throw error;
    if (error instanceof SyntaxError) throw new AppStoreRequestError("App Store 返回的版本信息无效，请稍后重试。");
    const message = error instanceof Error ? error.message : String(error);
    throw new AppStoreRequestError(/timeout|timed out/i.test(message) ? TIMEOUT_MESSAGE : "无法连接 App Store，请检查网络后重试。");
  } finally { clearTimeout(timer); }
}
