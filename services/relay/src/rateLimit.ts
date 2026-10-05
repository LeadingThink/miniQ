export interface RatePolicy {
  /** Messages a peer may send back-to-back after being idle. */
  burst: number;
  /** Sustained messages per second refilled into the bucket. */
  perSecond: number;
}

// The desktop daemon paces data frames at one per 350 ms (~3/s, chunks of
// 768 KiB included) and sends control messages (push, blob_ticket, goodbye)
// unpaced on a separate channel. A resync after a reconnect flushes queued
// frames and control traffic back-to-back, so the burst covers several minutes
// of queued output and the sustained rate leaves ~10x headroom over pacing.
export const DESKTOP_RATE: RatePolicy = { burst: 600, perSecond: 30 };
// Phones send user-driven RPC requests. The sustained rate keeps the previous
// 240 messages/minute budget; the burst absorbs reconnect resync traffic.
export const MOBILE_RATE: RatePolicy = { burst: 240, perSecond: 4 };

const OBJECT_BYTES_PER_MINUTE = 128 * 1024 * 1024;
const DROP_LOG_INTERVAL_MS = 10_000;

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(private readonly policy: RatePolicy, now = Date.now()) {
    this.tokens = policy.burst;
    this.updatedAt = now;
  }

  take(now = Date.now()): boolean {
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.policy.burst, this.tokens + elapsedSeconds * this.policy.perSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Fixed one-minute budget for object-storage ticket bytes. */
export class ObjectByteBudget {
  private windowStartedAt: number;
  private used = 0;

  constructor(now = Date.now()) {
    this.windowStartedAt = now;
  }

  reserve(bytes: number, now = Date.now()): boolean {
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.used = 0;
    }
    if (this.used + bytes > OBJECT_BYTES_PER_MINUTE) return false;
    this.used += bytes;
    return true;
  }
}

/** Counts silently dropped messages and logs at most once per interval. */
export class DropCounter {
  private dropped = 0;
  private lastLoggedAt = 0;

  record(label: string, now = Date.now()): void {
    this.dropped += 1;
    if (now - this.lastLoggedAt < DROP_LOG_INTERVAL_MS) return;
    console.warn(`[relay] ${label} over rate limit, dropped ${this.dropped} message(s)`);
    this.lastLoggedAt = now;
    this.dropped = 0;
  }
}
