import { checkAndroidUpdate, isMobileUpdateSupported, type MobileUpdateState } from "./mobileUpdate";

export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export const UPDATE_REMINDER_COOLDOWN = 24 * 60 * 60 * 1000;
export const UPDATE_FAILURE_COOLDOWN = 5 * 60 * 1000;
const KEY = "miniq:android-update:";

/** One coordinator for startup, resume and settings, including StrictMode remounts. */
export class MobileUpdateScheduler {
  private flight: Promise<MobileUpdateState> | null = null;
  private manual = false;
  private memory = new Map<string, number>();
  constructor(
    private check = checkAndroidUpdate,
    private supported = isMobileUpdateSupported,
    private now = Date.now,
  ) {}

  private recent(key: string, interval: number): boolean {
    let timestamp = this.memory.get(key) ?? 0;
    try { timestamp = Number(localStorage.getItem(KEY + key)) || timestamp; } catch { /* Storage is optional. */ }
    const elapsed = this.now() - timestamp;
    return timestamp > 0 && elapsed >= 0 && elapsed < interval;
  }

  private stamp(key: string) {
    const timestamp = this.now();
    this.memory.set(key, timestamp);
    try { localStorage.setItem(KEY + key, String(timestamp)); } catch { /* Keep in-memory cooldown. */ }
  }

  canPrompt(version: string) { return !this.recent(`reminder:${version}`, UPDATE_REMINDER_COOLDOWN); }

  defer(version: string) { this.stamp(`reminder:${version}`); }

  async run(manual = false): Promise<MobileUpdateState> {
    if (!this.supported()) return { phase: "idle" };
    if (this.flight) {
      if (manual) this.manual = true;
      const result = await this.flight;
      if (manual && result.phase === "available") this.defer(result.release.version);
      return manual ? result : { phase: "idle" };
    }
    if (!manual && (this.recent("checked", UPDATE_CHECK_INTERVAL) || this.recent("failed", UPDATE_FAILURE_COOLDOWN))) {
      return { phase: "idle" };
    }
    this.manual = manual;
    this.flight = this.check().catch((error): MobileUpdateState => ({ phase: "error", error: error instanceof Error ? error.message : "无法连接更新服务，请稍后重试。" }));
    try {
      const result = await this.flight;
      if (result.phase === "error") this.stamp("failed");
      else if (result.phase === "available" || result.phase === "unavailable") this.stamp("checked");
      if (!manual && (this.manual || (result.phase === "available" && this.recent(`reminder:${result.release.version}`, UPDATE_REMINDER_COOLDOWN)))) {
        return { phase: "idle" };
      }
      if (manual && result.phase === "available") this.defer(result.release.version);
      return result;
    } finally { this.flight = null; }
  }
}

export const mobileUpdateScheduler = new MobileUpdateScheduler();
