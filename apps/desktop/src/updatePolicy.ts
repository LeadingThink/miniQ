/** One place for every update-timing rule, so Android, iOS and desktop cannot drift. */

/** How soon the app may ask the update service again after a successful check.
 * A long window silently hid a release published shortly after the last check
 * (measured: up to 5 hours with no prompt), so this matches foreground intent. */
export const UPDATE_RECHECK_INTERVAL_MS = 60 * 1000;
/** Desktop also re-checks on a timer while it stays open. */
export const UPDATE_PERIODIC_CHECK_MS = 10 * 60 * 1000;
/** A user who chose "later" is not asked about the same version again for a day. */
export const UPDATE_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A failed check is retried after a short pause instead of hammering the service. */
export const UPDATE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** Delay before the first check so startup work finishes first. */
export const UPDATE_STARTUP_DELAY_MS = 2_000;

/** Persistent "when did we last do X" stamps with an in-memory fallback, shared
 * by every update flow so cooldowns survive restarts and unavailable storage. */
export class UpdateStamps {
  private memory = new Map<string, number>();
  constructor(private prefix: string, private now: () => number = Date.now) {}

  recent(key: string, interval: number): boolean {
    let timestamp = this.memory.get(key) ?? 0;
    try { timestamp = Number(localStorage.getItem(this.prefix + key)) || timestamp; } catch { /* Storage is optional. */ }
    const elapsed = this.now() - timestamp;
    return timestamp > 0 && elapsed >= 0 && elapsed < interval;
  }

  /** Forget every in-memory stamp (persisted ones are the caller's to clear). */
  reset(): void { this.memory.clear(); }

  stamp(key: string): void {
    const timestamp = this.now();
    this.memory.set(key, timestamp);
    try { localStorage.setItem(this.prefix + key, String(timestamp)); } catch { /* Keep in-memory cooldown. */ }
  }
}
