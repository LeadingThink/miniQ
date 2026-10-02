import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { dirname } from "node:path";

// Offline push for miniQ mobile clients.
//
// The relay never sees notification content: the desktop daemon encrypts the
// title/body with the room key and the phone decrypts it locally (iOS
// Notification Service Extension / Android receiver). The relay only knows the
// coarse kind (needed for interruption level) and an opaque collapse id.

export type PushPlatform = "apns" | "jpush";
export type PushKind = "completed" | "failed" | "attention" | "desktop_offline";

export interface PushRegistration {
  deviceId: string;
  platform: PushPlatform;
  token: string;
  /** APNs only: development builds must use the sandbox gateway. */
  environment: "sandbox" | "production";
  updatedAt: number;
  /** Kinds the user enabled on the phone; missing means all. */
  kinds?: PushKind[];
  /** Silent delivery window in the phone's local time. */
  quietHours?: QuietHours;
  lastResult?: PushResult;
  lastResultAt?: number;
}

export interface QuietHours {
  start: string;
  end: string;
  timeZone: string;
}

export interface PushNotification {
  kind: PushKind;
  collapseId: string;
  nonce?: string;
  ciphertext?: string;
  /** Set per device during quiet hours: no sound, no banner interruption. */
  quiet?: boolean;
}

export type PushResult = "sent" | "invalid_token" | "failed" | "unconfigured";

export interface PushGateway {
  send(registration: PushRegistration, notification: PushNotification): Promise<PushResult>;
  close?(): void;
}

const MAX_DEVICES_PER_ROOM = 8;
const MAX_PUSHES_PER_ROOM_PER_MINUTE = 60;
const TOKEN_PATTERN = /^[A-Za-z0-9:_.-]{16,512}$/;
const COLLAPSE_PATTERN = /^[0-9]{1,10}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const KINDS: ReadonlySet<string> = new Set(["completed", "failed", "attention"]);
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseQuietHours(raw: unknown): QuietHours | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { start, end, timeZone } = raw as Record<string, unknown>;
  if (typeof start !== "string" || !TIME_PATTERN.test(start) || typeof end !== "string" || !TIME_PATTERN.test(end)) return undefined;
  let zone = "UTC";
  if (typeof timeZone === "string" && timeZone.length <= 64) {
    try { new Intl.DateTimeFormat("en-US", { timeZone }); zone = timeZone; } catch { /* invalid zone: UTC */ }
  }
  return { start, end, timeZone: zone };
}

/** True when `now` falls inside the window (in the phone's time zone). Equal bounds mean all day. */
export function inQuietHours(quiet: QuietHours | undefined, now: Date = new Date()): boolean {
  if (!quiet) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const current = hour * 60 + minute;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Generic Chinese fallback text, shown when local decryption is impossible. */
export const FALLBACK_TEXT: Record<PushKind, { title: string; body: string }> = {
  completed: { title: "miniQ", body: "有会话需要你查看" },
  failed: { title: "miniQ", body: "有会话需要你查看" },
  attention: { title: "miniQ · 需要你操作", body: "有会话正在等待你的确认" },
  desktop_offline: { title: "miniQ", body: "桌面 miniQ 已离线，远程任务暂时无法继续" },
};

export function parseRegistration(raw: Record<string, unknown>, deviceId: string): PushRegistration | null {
  if (raw.platform !== "apns" && raw.platform !== "jpush") return null;
  if (typeof raw.token !== "string" || !TOKEN_PATTERN.test(raw.token)) return null;
  const environment = raw.environment === "sandbox" ? "sandbox" : "production";
  const registration: PushRegistration = { deviceId, platform: raw.platform, token: raw.token, environment, updatedAt: Date.now() };
  if (Array.isArray(raw.kinds)) {
    registration.kinds = raw.kinds.filter((kind): kind is PushKind => typeof kind === "string" && KINDS.has(kind));
  }
  const quietHours = parseQuietHours(raw.quietHours);
  if (quietHours) registration.quietHours = quietHours;
  return registration;
}

export function parsePush(raw: Record<string, unknown>): PushNotification | null {
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) return null;
  if (typeof raw.collapseId !== "string" || !COLLAPSE_PATTERN.test(raw.collapseId)) return null;
  if (typeof raw.nonce !== "string" || !NONCE_PATTERN.test(raw.nonce)) return null;
  // APNs payloads are capped at 4 KiB; the daemon truncates titles/errors well below that.
  if (typeof raw.ciphertext !== "string" || raw.ciphertext.length < 22 || raw.ciphertext.length > 2400) return null;
  return { kind: raw.kind as PushKind, collapseId: raw.collapseId, nonce: raw.nonce, ciphertext: raw.ciphertext };
}

/** Room-scoped token registry, optionally persisted to a JSON file. */
export class PushRegistry {
  private readonly rooms = new Map<string, PushRegistration[]>();

  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, PushRegistration[]>;
      for (const [room, registrations] of Object.entries(data)) {
        if (Array.isArray(registrations)) this.rooms.set(room, registrations.slice(0, MAX_DEVICES_PER_ROOM));
      }
    } catch {
      console.error("Push registry could not be loaded; starting empty");
    }
  }

  list(roomId: string): PushRegistration[] {
    return this.rooms.get(roomId) ?? [];
  }

  upsert(roomId: string, registration: PushRegistration): void {
    // One token belongs to one device: drop it from other entries (reinstalls, device id resets).
    const rest = this.list(roomId).filter((item) => item.deviceId !== registration.deviceId && item.token !== registration.token);
    const next = [registration, ...rest].slice(0, MAX_DEVICES_PER_ROOM);
    this.rooms.set(roomId, next);
    this.save();
  }

  remove(roomId: string, deviceId: string, token?: string): boolean {
    const current = this.list(roomId);
    const next = current.filter((item) => item.deviceId !== deviceId || (token !== undefined && item.token !== token));
    if (next.length === current.length) return false;
    if (next.length) this.rooms.set(roomId, next);
    else this.rooms.delete(roomId);
    this.save();
    return true;
  }

  record(roomId: string, deviceId: string, result: PushResult): void {
    const item = this.list(roomId).find((entry) => entry.deviceId === deviceId);
    if (!item) return;
    item.lastResult = result;
    item.lastResultAt = Date.now();
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.rooms)), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      console.error("Push registry could not be saved");
    }
  }
}

/** Fans a push out to the gateways and applies per-room rate limits. */
export class PushService {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    readonly registry: PushRegistry,
    private readonly gateways: Partial<Record<PushPlatform, PushGateway>>,
  ) {}

  enabled(platform: PushPlatform): boolean {
    return Boolean(this.gateways[platform]);
  }

  /** Sends to every registered device of a room except those the caller says are actively viewing. */
  async deliver(roomId: string, notification: PushNotification, skip: (deviceId: string) => boolean): Promise<void> {
    if (!this.consume(roomId)) return;
    const targets = this.registry.list(roomId).filter((registration) =>
      !skip(registration.deviceId)
      // desktop_offline is a connectivity warning, not a task notification.
      && (notification.kind === "desktop_offline" || !registration.kinds || registration.kinds.includes(notification.kind)));
    await Promise.all(targets.map(async (registration) => {
      const gateway = this.gateways[registration.platform];
      let result: PushResult = "unconfigured";
      if (gateway) {
        try {
          result = await gateway.send(registration, { ...notification, quiet: inQuietHours(registration.quietHours) });
        } catch {
          result = "failed";
        }
      }
      if (result === "invalid_token") this.registry.remove(roomId, registration.deviceId, registration.token);
      else this.registry.record(roomId, registration.deviceId, result);
    }));
  }

  close(): void {
    for (const gateway of Object.values(this.gateways)) gateway?.close?.();
  }

  private consume(roomId: string): boolean {
    const now = Date.now();
    const window = this.windows.get(roomId);
    if (!window || now - window.startedAt >= 60_000) {
      this.windows.set(roomId, { startedAt: now, count: 1 });
      if (this.windows.size > 10_000) this.windows.clear();
      return true;
    }
    window.count += 1;
    return window.count <= MAX_PUSHES_PER_ROOM_PER_MINUTE;
  }
}

// ---------------------------------------------------------------------------
// APNs (token-based auth with a .p8 key over HTTP/2)

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKey: string;
}

export class ApnsGateway implements PushGateway {
  private readonly key: KeyObject;
  private jwt?: { value: string; issuedAt: number };
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(private readonly config: ApnsConfig) {
    this.key = createPrivateKey(config.privateKey);
  }

  async send(registration: PushRegistration, notification: PushNotification): Promise<PushResult> {
    const result = await this.sendTo(registration.environment, registration, notification);
    if (result !== "invalid_token") return result;
    // Xcode debug builds receive sandbox tokens and release builds production
    // tokens; the app cannot tell which, so retry the other gateway once and
    // remember the environment that accepted the token.
    const other = registration.environment === "sandbox" ? "production" : "sandbox";
    const retried = await this.sendTo(other, registration, notification);
    if (retried === "sent") registration.environment = other;
    return retried === "sent" ? "sent" : "invalid_token";
  }

  private async sendTo(
    environment: PushRegistration["environment"],
    registration: PushRegistration,
    notification: PushNotification,
  ): Promise<PushResult> {
    const host = environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    const body = JSON.stringify(apnsPayload(notification));
    const headers = {
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: `/3/device/${registration.token}`,
      authorization: `bearer ${this.token()}`,
      "apns-topic": this.config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": notification.collapseId,
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 3600),
    };
    const { status, reason } = await this.request(host, headers, body);
    if (status === 200) return "sent";
    if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") return "invalid_token";
    if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") this.jwt = undefined;
    return "failed";
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private token(): string {
    const now = Math.floor(Date.now() / 1000);
    // Apple rejects tokens older than one hour and throttles refreshes faster than 20 minutes.
    if (this.jwt && now - this.jwt.issuedAt < 40 * 60) return this.jwt.value;
    const header = base64url(JSON.stringify({ alg: "ES256", kid: this.config.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.config.teamId, iat: now }));
    const signature = createSign("SHA256").update(`${header}.${claims}`).sign({ key: this.key, dsaEncoding: "ieee-p1363" });
    this.jwt = { value: `${header}.${claims}.${base64url(signature)}`, issuedAt: now };
    return this.jwt.value;
  }

  private session(host: string): ClientHttp2Session {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(host);
    session.on("error", () => this.sessions.delete(host));
    session.on("close", () => this.sessions.delete(host));
    session.unref();
    this.sessions.set(host, session);
    return session;
  }

  private request(host: string, headers: Record<string, string>, body: string): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve, reject) => {
      const stream = this.session(host).request(headers);
      let status = 0;
      let data = "";
      stream.setTimeout(10_000, () => stream.close(constants.NGHTTP2_CANCEL));
      stream.on("response", (response) => { status = Number(response[constants.HTTP2_HEADER_STATUS]); });
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => { data += chunk; });
      stream.on("error", reject);
      stream.on("close", () => {
        if (!status) return reject(new Error("APNs request failed"));
        let reason: string | undefined;
        try { reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined; } catch { /* ignore */ }
        resolve({ status, reason });
      });
      stream.end(body);
    });
  }
}

export function apnsPayload(notification: PushNotification): Record<string, unknown> {
  const fallback = FALLBACK_TEXT[notification.kind];
  const quiet = notification.quiet === true;
  return {
    aps: {
      alert: { title: fallback.title, body: fallback.body },
      ...(quiet ? {} : { sound: "default" }),
      // Lets the Notification Service Extension replace the text with the decrypted content.
      "mutable-content": 1,
      // Opens the notification's "批准 / 拒绝" actions (registered by the app).
      ...(notification.kind === "attention" ? { category: "MINIQ_ATTENTION" } : {}),
      "thread-id": notification.kind === "desktop_offline" ? "miniq-desktop" : `push:${notification.collapseId}`,
      "interruption-level": quiet ? "passive" : notification.kind === "attention" ? "time-sensitive" : "active",
    },
    miniq: {
      v: 1,
      kind: notification.kind,
      notificationId: notification.collapseId,
      ...(notification.nonce ? { nonce: notification.nonce, ciphertext: notification.ciphertext } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// JPush (Android vendor-channel aggregation). Another provider (Getui, Aliyun)
// can be added by implementing PushGateway.

export interface JPushConfig {
  appKey: string;
  masterSecret: string;
  production: boolean;
  endpoint?: string;
}

export class JPushGateway implements PushGateway {
  constructor(private readonly config: JPushConfig) {}

  async send(registration: PushRegistration, notification: PushNotification): Promise<PushResult> {
    const response = await fetch(this.config.endpoint ?? "https://api.jpush.cn/v3/push", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.appKey}:${this.config.masterSecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(jpushPayload(registration.token, notification, this.config.production)),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "sent";
    const text = await response.text().catch(() => "");
    // 1011: no valid target (unregistered / uninstalled).
    if (response.status === 400 && /"code"\s*:\s*1011/.test(text)) return "invalid_token";
    return "failed";
  }
}

export function jpushPayload(registrationId: string, notification: PushNotification, production: boolean): Record<string, unknown> {
  const fallback = FALLBACK_TEXT[notification.kind];
  const quiet = notification.quiet === true;
  const extras = {
    miniqKind: notification.kind,
    miniqNotificationId: notification.collapseId,
    ...(quiet ? { miniqQuiet: "1" } : {}),
    ...(notification.nonce ? { miniqNonce: notification.nonce, miniqCiphertext: notification.ciphertext } : {}),
  };
  return {
    platform: ["android"],
    audience: { registration_id: [registrationId] },
    notification: {
      android: {
        alert: fallback.body,
        title: fallback.title,
        // Matches the channels created in apps/desktop/src/taskNotifications.ts.
        channel_id: quiet ? "miniq-quiet" : notification.kind === "attention" ? "miniq-attention" : "miniq-results",
        priority: quiet ? 0 : notification.kind === "attention" ? 2 : 1,
        extras,
      },
    },
    // Delivered to the app process when it is alive so it can decrypt and show real text.
    message: { msg_content: notification.kind, extras },
    options: { time_to_live: 86400, apns_production: production, apns_collapse_id: notification.collapseId },
  };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** Builds the push service from MINIQ_* environment variables. */
export function configuredPushService(env: NodeJS.ProcessEnv = process.env): PushService {
  const gateways: Partial<Record<PushPlatform, PushGateway>> = {};
  const keyPath = env.MINIQ_APNS_KEY_PATH;
  const keyInline = env.MINIQ_APNS_KEY;
  if ((keyPath || keyInline) && env.MINIQ_APNS_KEY_ID && env.MINIQ_APNS_TEAM_ID) {
    try {
      gateways.apns = new ApnsGateway({
        keyId: env.MINIQ_APNS_KEY_ID,
        teamId: env.MINIQ_APNS_TEAM_ID,
        bundleId: env.MINIQ_APNS_BUNDLE_ID ?? "com.leadingthink.miniq",
        privateKey: keyInline ?? readFileSync(keyPath!, "utf8"),
      });
    } catch {
      console.error("APNs key could not be loaded; iOS push disabled");
    }
  }
  if (env.MINIQ_JPUSH_APP_KEY && env.MINIQ_JPUSH_MASTER_SECRET) {
    gateways.jpush = new JPushGateway({
      appKey: env.MINIQ_JPUSH_APP_KEY,
      masterSecret: env.MINIQ_JPUSH_MASTER_SECRET,
      production: env.MINIQ_JPUSH_PRODUCTION !== "false",
    });
  }
  return new PushService(new PushRegistry(env.MINIQ_PUSH_REGISTRY_FILE), gateways);
}
