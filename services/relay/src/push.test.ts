import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { createRelayServer } from "./server.js";
import {
  ApnsGateway,
  PushRegistry,
  PushService,
  apnsPayload,
  jpushPayload,
  inQuietHours,
  parseRegistration,
  parsePush,
  type PushGateway,
  type PushNotification,
  type PushRegistration,
  type PushResult,
} from "./push.js";

const servers: ReturnType<typeof createRelayServer>[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

class FakeGateway implements PushGateway {
  sent: Array<{ registration: PushRegistration; notification: PushNotification }> = [];
  constructor(private readonly result: PushResult = "sent") {}
  async send(registration: PushRegistration, notification: PushNotification): Promise<PushResult> {
    this.sent.push({ registration, notification });
    return this.result;
  }
}

function identity(key: string) {
  const derive = (label: string) => createHash("sha256").update(label).update(Buffer.from([0])).update(key).digest("base64url");
  return { roomId: derive("miniq-relay-room-v1"), authToken: derive("miniq-relay-auth-v1") };
}

function hello(role: "desktop" | "mobile", deviceId: string) {
  return { type: "hello", protocol: 1, role, ...identity("sk-push"), deviceId, deviceName: role };
}

async function start(push: PushService, desktopReconnectGraceMs = 20, desktopOfflinePushMs = 60_000) {
  const server = createRelayServer({ allowedOrigins: ["http://test.local"], push, desktopReconnectGraceMs, desktopOfflinePushMs });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `ws://127.0.0.1:${address.port}/ws`;
}

function connect(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { origin: "http://test.local" });
    socket.once("open", () => { clients.push(socket); resolve(socket); });
    socket.once("error", reject);
  });
}

function nextType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: RawData) => {
      const value = JSON.parse(data.toString()) as Record<string, unknown>;
      if (value.type === type) { socket.off("message", onMessage); resolve(value); }
    };
    socket.on("message", onMessage);
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN = "a".repeat(64);
const PUSH = { type: "push", kind: "completed", collapseId: "12345", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "B".repeat(40) };

async function room(push: PushService, offlineMs?: number) {
  const url = await start(push, 20, offlineMs);
  const desktop = await connect(url);
  const desktopReady = nextType(desktop, "ready");
  desktop.send(JSON.stringify(hello("desktop", "desktop-0001")));
  await desktopReady;
  const mobile = await connect(url);
  const mobileReady = nextType(mobile, "ready");
  mobile.send(JSON.stringify(hello("mobile", "mobile-phone-1")));
  await mobileReady;
  const registered = nextType(mobile, "push_registered");
  mobile.send(JSON.stringify({ type: "push_register", platform: "apns", token: TOKEN, environment: "sandbox" }));
  expect(await registered).toMatchObject({ enabled: true });
  return { url, desktop, mobile };
}

describe("relay push", () => {
  it("suppresses pushes while the phone is in the foreground and sends once it is backgrounded", async () => {
    const gateway = new FakeGateway();
    const service = new PushService(new PushRegistry(), { apns: gateway });
    const { desktop, mobile } = await room(service);

    desktop.send(JSON.stringify(PUSH));
    await wait(50);
    expect(gateway.sent).toHaveLength(0);

    mobile.send(JSON.stringify({ type: "app_state", foreground: false }));
    await wait(20);
    desktop.send(JSON.stringify(PUSH));
    await wait(50);
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0].registration).toMatchObject({ deviceId: "mobile-phone-1", token: TOKEN, environment: "sandbox" });
    expect(gateway.sent[0].notification).toEqual({ kind: "completed", collapseId: "12345", nonce: PUSH.nonce, ciphertext: PUSH.ciphertext, quiet: false });
  });

  it("pushes to registered phones after they disconnect, and rejects pushes from mobiles", async () => {
    const gateway = new FakeGateway();
    const service = new PushService(new PushRegistry(), { apns: gateway });
    const { desktop, mobile } = await room(service);
    mobile.send(JSON.stringify(PUSH));
    await wait(30);
    expect(gateway.sent).toHaveLength(0);
    mobile.close();
    await wait(30);
    desktop.send(JSON.stringify(PUSH));
    await wait(50);
    expect(gateway.sent).toHaveLength(1);
  });

  it("removes tokens the gateway reports as invalid", async () => {
    const gateway = new FakeGateway("invalid_token");
    const registry = new PushRegistry();
    const service = new PushService(registry, { apns: gateway });
    const { desktop, mobile } = await room(service);
    mobile.send(JSON.stringify({ type: "app_state", foreground: false }));
    await wait(20);
    desktop.send(JSON.stringify(PUSH));
    await wait(50);
    expect(gateway.sent).toHaveLength(1);
    expect(registry.list(identity("sk-push").roomId)).toHaveLength(0);
  });

  it("notifies phones once when the desktop stays offline, but not after a goodbye", async () => {
    const gateway = new FakeGateway();
    const service = new PushService(new PushRegistry(), { apns: gateway });
    const { url, desktop } = await room(service, 80);
    desktop.close();
    await wait(200);
    expect(gateway.sent.map((item) => item.notification.kind)).toEqual(["desktop_offline"]);

    const again = await connect(url);
    const ready = nextType(again, "ready");
    again.send(JSON.stringify(hello("desktop", "desktop-0001")));
    await ready;
    again.send(JSON.stringify({ type: "desktop_goodbye" }));
    await wait(20);
    again.close();
    await wait(200);
    expect(gateway.sent).toHaveLength(1);
  });

  it("cancels the offline push when the desktop reconnects in time", async () => {
    const gateway = new FakeGateway();
    const service = new PushService(new PushRegistry(), { apns: gateway });
    const { url, desktop } = await room(service, 150);
    desktop.close();
    await wait(30);
    const again = await connect(url);
    const ready = nextType(again, "ready");
    again.send(JSON.stringify(hello("desktop", "desktop-0001")));
    await ready;
    await wait(250);
    expect(gateway.sent).toHaveLength(0);
  });

  it("only pushes kinds the phone enabled and marks quiet-hour deliveries", async () => {
    const gateway = new FakeGateway();
    const service = new PushService(new PushRegistry(), { apns: gateway });
    const { desktop, mobile } = await room(service);
    const registered = nextType(mobile, "push_registered");
    mobile.send(JSON.stringify({
      type: "push_register", platform: "apns", token: TOKEN, kinds: ["attention"],
      quietHours: { start: "00:00", end: "00:00", timeZone: "Asia/Shanghai" },
    }));
    await registered;
    mobile.send(JSON.stringify({ type: "app_state", foreground: false }));
    await wait(20);
    desktop.send(JSON.stringify(PUSH));
    desktop.send(JSON.stringify({ ...PUSH, kind: "attention" }));
    await wait(50);
    expect(gateway.sent.map((item) => [item.notification.kind, item.notification.quiet])).toEqual([["attention", true]]);
  });

  it("reports when a platform is not configured", async () => {
    const service = new PushService(new PushRegistry(), {});
    const url = await start(service);
    const desktop = await connect(url);
    const desktopReady = nextType(desktop, "ready");
    desktop.send(JSON.stringify(hello("desktop", "desktop-0001")));
    await desktopReady;
    const mobile = await connect(url);
    const mobileReady = nextType(mobile, "ready");
    mobile.send(JSON.stringify(hello("mobile", "mobile-phone-1")));
    await mobileReady;
    const registered = nextType(mobile, "push_registered");
    mobile.send(JSON.stringify({ type: "push_register", platform: "jpush", token: TOKEN }));
    expect(await registered).toMatchObject({ platform: "jpush", enabled: false });
  });
});

describe("push registry and payloads", () => {
  it("persists registrations and keeps one entry per device and token", () => {
    const file = join(mkdtempSync(join(tmpdir(), "miniq-push-")), "registry.json");
    const registry = new PushRegistry(file);
    const base = { platform: "apns" as const, environment: "production" as const, updatedAt: 1 };
    registry.upsert("room", { ...base, deviceId: "phone-a", token: TOKEN });
    registry.upsert("room", { ...base, deviceId: "phone-a", token: "b".repeat(64) });
    registry.upsert("room", { ...base, deviceId: "phone-b", token: "b".repeat(64) });
    expect(registry.list("room").map((item) => item.deviceId)).toEqual(["phone-b"]);
    expect(JSON.parse(readFileSync(file, "utf8")).room).toHaveLength(1);
    expect(new PushRegistry(file).list("room")).toHaveLength(1);
  });

  it("validates daemon push frames", () => {
    expect(parsePush(PUSH)).not.toBeNull();
    expect(parsePush({ ...PUSH, kind: "desktop_offline" })).toBeNull();
    expect(parsePush({ ...PUSH, collapseId: "abc" })).toBeNull();
    expect(parsePush({ ...PUSH, ciphertext: "x".repeat(5000) })).toBeNull();
  });

  it("builds APNs payloads the Notification Service Extension can decrypt", () => {
    const payload = apnsPayload({ kind: "attention", collapseId: "7", nonce: "n", ciphertext: "c" });
    expect(payload).toMatchObject({
      aps: { "mutable-content": 1, "interruption-level": "time-sensitive" },
      miniq: { kind: "attention", notificationId: "7", nonce: "n", ciphertext: "c" },
    });
    expect(JSON.stringify(payload)).not.toContain("sessionId");
  });

  it("builds JPush payloads on the existing Android channels", () => {
    const payload = jpushPayload("reg", { kind: "attention", collapseId: "7", nonce: "n", ciphertext: "c" }, true) as {
      notification: { android: { channel_id: string; extras: Record<string, string> } };
    };
    expect(payload.notification.android.channel_id).toBe("miniq-attention");
    expect(payload.notification.android.extras.miniqCiphertext).toBe("c");
  });

  it("evaluates quiet hours in the phone's time zone, including overnight windows", () => {
    const at = new Date("2024-01-01T15:30:00Z"); // 23:30 in Shanghai
    expect(inQuietHours({ start: "23:00", end: "07:00", timeZone: "Asia/Shanghai" }, at)).toBe(true);
    expect(inQuietHours({ start: "23:00", end: "07:00", timeZone: "UTC" }, at)).toBe(false);
    expect(inQuietHours({ start: "09:00", end: "18:00", timeZone: "UTC" }, at)).toBe(true);
    expect(inQuietHours(undefined, at)).toBe(false);
  });

  it("parses registration preferences defensively", () => {
    const registration = parseRegistration({
      platform: "apns", token: TOKEN, kinds: ["completed", "bogus"],
      quietHours: { start: "22:00", end: "7:00", timeZone: "UTC" },
    }, "phone");
    expect(registration?.kinds).toEqual(["completed"]);
    expect(registration?.quietHours).toBeUndefined();
    expect(parseRegistration({ platform: "apns", token: TOKEN, quietHours: { start: "22:00", end: "07:00", timeZone: "Nowhere/Zone" } }, "p")?.quietHours)
      .toEqual({ start: "22:00", end: "07:00", timeZone: "UTC" });
  });

  it("silences quiet-hour payloads and adds approval actions to attention pushes", () => {
    const quiet = apnsPayload({ kind: "completed", collapseId: "7", quiet: true }) as { aps: Record<string, unknown> };
    expect(quiet.aps.sound).toBeUndefined();
    expect(quiet.aps["interruption-level"]).toBe("passive");
    expect((apnsPayload({ kind: "attention", collapseId: "7" }) as { aps: Record<string, unknown> }).aps.category).toBe("MINIQ_ATTENTION");
    const android = jpushPayload("reg", { kind: "attention", collapseId: "7", quiet: true }, true) as {
      notification: { android: { channel_id: string } };
    };
    expect(android.notification.android.channel_id).toBe("miniq-quiet");
  });

  it("signs APNs provider tokens with ES256", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const gateway = new ApnsGateway({
      keyId: "KEY1234567",
      teamId: "TEAM123456",
      bundleId: "com.leadingthink.miniq",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const token = (gateway as unknown as { token(): string }).token();
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({ iss: "TEAM123456" });
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    gateway.close();
  });
});
