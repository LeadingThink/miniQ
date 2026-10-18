import { compareVersions, isReleaseVersion } from "./mobileUpdate";

export type UpdatePlatform = "ios" | "android" | "desktop";
export interface InstalledReleaseNotice { version: string; releaseNotes: string[] }
const versionKey = (version: string) => version.trim().replace(/^v/i, "").split(".").map(Number).join(".").replace(/(?:\.0)+$/, "");

/** Version-specific notes are cached before an update; the latest published
 * release must never be used as notes for a different installed build. One
 * instance per platform keeps its own baseline, so iOS, Android and desktop
 * each announce "已更新至 …" exactly once. */
export class InstalledReleaseNotices {
  private failedWrites = new Set<string>();
  private memory = new Map<string, string>();
  private readonly prefix: string;
  constructor(private platform: UpdatePlatform, private storage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  }) { this.prefix = `miniq:${platform}-installed-release:`; }
  private read(key: string): string | null {
    if (this.failedWrites.has(key)) return this.memory.get(key) ?? null;
    try { return this.storage.getItem(this.prefix + key) ?? this.memory.get(key) ?? null; }
    catch { return this.memory.get(key) ?? null; }
  }
  private write(key: string, value: string) {
    this.memory.set(key, value);
    try { this.storage.setItem(this.prefix + key, value); this.failedWrites.delete(key); }
    catch { this.failedWrites.add(key); }
  }
  cache(release: { platform?: UpdatePlatform; version: string; releaseNotes?: string[] }) {
    // Android manifests omit the platform field; every other source states it.
    if ((release.platform ?? "android") !== this.platform || !isReleaseVersion(release.version) || !release.releaseNotes?.length) return;
    this.write(`notes:${versionKey(release.version)}`, JSON.stringify(release.releaseNotes));
  }
  pending(version: string): InstalledReleaseNotice | null {
    if (!isReleaseVersion(version)) return null;
    const baseline = this.read("baseline");
    if (!baseline || !isReleaseVersion(baseline)) { this.write("baseline", version); return null; }
    if (compareVersions(version, baseline) <= 0) return null;
    let releaseNotes: string[] = [];
    try {
      const notes: unknown = JSON.parse(this.read(`notes:${versionKey(version)}`) ?? "[]");
      if (Array.isArray(notes) && notes.every((note) => typeof note === "string")) releaseNotes = notes;
    } catch { /* Missing/corrupt notes use honest generic copy. */ }
    return { version, releaseNotes };
  }
  markShown(version: string) { this.write("baseline", version); }
}
export const iosInstalledReleaseNotices = new InstalledReleaseNotices("ios");
export const androidInstalledReleaseNotices = new InstalledReleaseNotices("android");
export const desktopInstalledReleaseNotices = new InstalledReleaseNotices("desktop");

/** The store which belongs to the running mobile platform. */
export function installedNoticesFor(platform: string): InstalledReleaseNotices {
  return platform === "ios" ? iosInstalledReleaseNotices : androidInstalledReleaseNotices;
}
