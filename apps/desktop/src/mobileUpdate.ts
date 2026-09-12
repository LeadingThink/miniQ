import { Capacitor } from "@capacitor/core";

/** Android builds ship outside an app store, so updates are discovered by
 * comparing the local versionName against the public release manifest. */
export const RELEASE_MANIFEST_URL = "https://oss.zaiwen.top/releases/manifest.json";

export interface AndroidRelease {
  version: string;
  url: string;
  releaseDate?: string;
  fileSize?: number;
  minAndroidVersion?: string;
  installationNotes: string[];
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

/** Numeric-segment comparison; returns >0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Fail closed: anything other than a published release with a usable https
 * APK url is treated as "no update available". */
export function parseAndroidRelease(manifest: unknown): AndroidRelease | null {
  const platforms = (manifest as { products?: { miniq?: { platforms?: Record<string, unknown> } } })?.products?.miniq
    ?.platforms;
  const entry = platforms?.android as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== "object") return null;
  if (entry.status !== undefined && entry.status !== "available") return null;
  const version = typeof entry.version === "string" ? entry.version.trim() : "";
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (!version || !url.startsWith("https://")) return null;
  return {
    version,
    url,
    releaseDate: typeof entry.releaseDate === "string" ? entry.releaseDate : undefined,
    fileSize: typeof entry.fileSize === "number" ? entry.fileSize : undefined,
    minAndroidVersion: typeof entry.minAndroidVersion === "string" ? entry.minAndroidVersion : undefined,
    installationNotes: Array.isArray(entry.installationNotes)
      ? entry.installationNotes.filter((note): note is string => typeof note === "string")
      : [],
  };
}

export async function readInstalledVersion(): Promise<string | null> {
  if (!isMobileUpdateSupported()) return null;
  try {
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo();
    return info.version || null;
  } catch {
    return null;
  }
}

export async function fetchAndroidRelease(
  fetchImpl: typeof fetch = fetch,
  url: string = RELEASE_MANIFEST_URL,
): Promise<AndroidRelease | null> {
  const response = await fetchImpl(`${url}?release_check=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`发布清单请求失败（HTTP ${response.status}）`);
  return parseAndroidRelease(await response.json());
}

export async function checkAndroidUpdate(options: {
  currentVersion?: string | null;
  fetchImpl?: typeof fetch;
  manifestUrl?: string;
} = {}): Promise<MobileUpdateState> {
  const current = options.currentVersion ?? (await readInstalledVersion());
  if (!current) return { phase: "error", error: "无法读取当前版本号" };
  const release = await fetchAndroidRelease(options.fetchImpl ?? fetch, options.manifestUrl ?? RELEASE_MANIFEST_URL);
  if (!release || compareVersions(release.version, current) <= 0) {
    return { phase: "unavailable", version: current };
  }
  return { phase: "available", release };
}

export function formatFileSize(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}
