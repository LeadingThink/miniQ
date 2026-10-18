import { checkMobileUpdate, isMobileUpdateSupported, type MobileUpdateState } from "./mobileUpdate";
import { UPDATE_FAILURE_COOLDOWN_MS, UPDATE_RECHECK_INTERVAL_MS, UPDATE_REMINDER_COOLDOWN_MS, UpdateStamps } from "./updatePolicy";

export const UPDATE_CHECK_INTERVAL = UPDATE_RECHECK_INTERVAL_MS;
export const UPDATE_REMINDER_COOLDOWN = UPDATE_REMINDER_COOLDOWN_MS;
export const UPDATE_FAILURE_COOLDOWN = UPDATE_FAILURE_COOLDOWN_MS;

/** One coordinator for startup, resume and settings, including StrictMode remounts. */
export class MobileUpdateScheduler {
  private flight: Promise<MobileUpdateState> | null = null;
  private manual = false;
  private stamps: UpdateStamps;
  constructor(
    private check = checkMobileUpdate,
    private supported = isMobileUpdateSupported,
    now = Date.now,
  ) { this.stamps = new UpdateStamps("miniq:android-update:", now); }

  private recent(key: string, interval: number): boolean { return this.stamps.recent(key, interval); }

  private stamp(key: string) { this.stamps.stamp(key); }

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
