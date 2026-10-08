import { compareVersions, isReleaseVersion } from "./mobileUpdate";

export interface InstalledReleaseNotice { version: string; releaseNotes: string[] }
const PREFIX = "miniq:ios-installed-release:";
const versionKey = (version: string) => version.trim().replace(/^v/i, "").split(".").map(Number).join(".").replace(/(?:\.0)+$/, "");

/** Version-specific notes are cached before an App Store update; the store's
 * latest release must never be used as notes for a different installed build. */
export class IosInstalledReleaseNotices {
  private failedWrites = new Set<string>();
  private memory = new Map<string, string>();
  constructor(private storage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  }) {}
  private read(key: string): string | null {
    if (this.failedWrites.has(key)) return this.memory.get(key) ?? null;
    try { return this.storage.getItem(PREFIX + key) ?? this.memory.get(key) ?? null; }
    catch { return this.memory.get(key) ?? null; }
  }
  private write(key: string, value: string) {
    this.memory.set(key, value);
    try { this.storage.setItem(PREFIX + key, value); this.failedWrites.delete(key); }
    catch { this.failedWrites.add(key); }
  }
  cache(release: { platform?: "ios" | "android"; version: string; releaseNotes?: string[] }) {
    if (release.platform !== "ios" || !isReleaseVersion(release.version) || !release.releaseNotes?.length) return;
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
export const iosInstalledReleaseNotices = new IosInstalledReleaseNotices();
