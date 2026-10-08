import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RelayBroker } from "./broker.js";
import { PushRegistry, PushService } from "./push.js";

const brokers: RelayBroker[] = [];
afterEach(() => { brokers.splice(0).forEach((b) => b.close()); vi.useRealTimers(); });
function socket() {
  const messages: Record<string, unknown>[] = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: vi.fn((data: string) => messages.push(JSON.parse(data))), close: vi.fn(),
  };
  return { ws: ws as unknown as WebSocket, messages };
}
function hello(role: "desktop" | "mobile", deviceId: string, targetDeviceId?: string) {
  return { type: "hello", protocol: 2, roomId: "r".repeat(43), authToken: "a".repeat(43), role, deviceId, deviceName: deviceId, targetDeviceId };
}
const frame = { type: "frame", target: "mobiles", nonce: "n".repeat(16), ciphertext: "c".repeat(22) };

it("revokes every old-socket control path and suppresses its pending blob response", async () => {
  let resolve!: (ticket: { putUrl: string; getUrl: string; expiresAt: number }) => void;
  const ticket = vi.fn(() => new Promise<{ putUrl: string; getUrl: string; expiresAt: number }>((done) => { resolve = done; }));
  const broker = new RelayBroker({ enabledFor: () => true, ticket }); brokers.push(broker);
  const old = socket(), fresh = socket(), mobile = socket();
  broker.register(old.ws, hello("desktop", "desktop-aaaa"));
  broker.register(mobile.ws, hello("mobile", "mobile-aaaa", "desktop-aaaa"));
  broker.route(old.ws, { type: "blob_ticket", requestId: "pending", bytes: 1024 });
  broker.register(fresh.ws, hello("desktop", "desktop-aaaa"));
  old.messages.length = 0; mobile.messages.length = 0;
  broker.route(old.ws, frame);
  broker.route(old.ws, { type: "desktop_goodbye" });
  broker.route(old.ws, { type: "blob_ticket", requestId: "stale", bytes: 1024 });
  broker.disconnect(old.ws);
  resolve({ putUrl: "put", getUrl: "get", expiresAt: 1 });
  await Promise.resolve();
  expect(old.messages).toEqual([]);
  expect(mobile.messages).toEqual([]);
  expect(ticket).toHaveBeenCalledTimes(1);
  broker.route(fresh.ws, frame);
  expect(mobile.messages).toHaveLength(1);
});

it("isolates push registration, foreground suppression and offline timers per desktop", async () => {
  vi.useFakeTimers();
  const gateway = { send: vi.fn(async () => "sent" as const) };
  const push = new PushService(new PushRegistry(), { apns: gateway });
  const broker = new RelayBroker(undefined, 10, push, 100); brokers.push(broker);
  const a = socket(), b = socket(), ma = socket(), mb = socket();
  broker.register(a.ws, hello("desktop", "desktop-aaaa"));
  broker.register(b.ws, hello("desktop", "desktop-bbbb"));
  broker.register(ma.ws, hello("mobile", "mobile-shared", "desktop-aaaa"));
  broker.register(mb.ws, hello("mobile", "mobile-shared", "desktop-bbbb"));
  const registration = { type: "push_register", platform: "apns", token: "t".repeat(64) };
  broker.route(ma.ws, registration); broker.route(mb.ws, registration);
  broker.route(ma.ws, { type: "app_state", foreground: false });
  broker.route(a.ws, { type: "push", kind: "attention", collapseId: "1", nonce: "n".repeat(16), ciphertext: "c".repeat(22) });
  await Promise.resolve();
  expect(gateway.send).toHaveBeenCalledTimes(1);
  gateway.send.mockClear();
  broker.disconnect(a.ws);
  const b2 = socket(); broker.register(b2.ws, hello("desktop", "desktop-bbbb"));
  await vi.advanceTimersByTimeAsync(101);
  expect(gateway.send).toHaveBeenCalledTimes(1);
  expect(gateway.send.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "desktop_offline" })]));
  expect(mb.ws.close).not.toHaveBeenCalled();
});

it("binds legacy phones to the single online desktop and forgets offline ones", () => {
  vi.useFakeTimers();
  const broker = new RelayBroker(undefined, 10); brokers.push(broker);
  const a = socket(), b = socket(), a2 = socket();
  broker.register(a.ws, hello("desktop", "desktop-aaaa"));
  broker.disconnect(a.ws); vi.advanceTimersByTime(11);
  expect(broker.roomCount()).toBe(0);
  const offline = socket();
  expect(broker.register(offline.ws, { ...hello("mobile", "mobile-legacy"), protocol: 1 })).toBe(false);
  expect(offline.messages[0]).toMatchObject({ code: "desktop_offline" });
  broker.register(b.ws, hello("desktop", "desktop-bbbb"));
  const single = socket();
  expect(broker.register(single.ws, { ...hello("mobile", "mobile-legacy"), protocol: 1 })).toBe(true);
  expect(single.messages[0]).toMatchObject({ type: "ready", desktopOnline: true, desktopDeviceId: "desktop-bbbb" });
  broker.register(a2.ws, hello("desktop", "desktop-aaaa"));
  const ambiguous = socket();
  expect(broker.register(ambiguous.ws, { ...hello("mobile", "mobile-legacy"), protocol: 1 })).toBe(false);
  expect(ambiguous.messages[0]).toMatchObject({ code: "device_selection_required" });
  const wrongToken = socket();
  expect(broker.register(wrongToken.ws, { ...hello("mobile", "mobile-wrong", "desktop-bbbb"), authToken: "b".repeat(43) })).toBe(false);
  expect(wrongToken.messages[0]).toMatchObject({ code: "unauthorized" });
});

it("authenticates push source and gives each offline desktop a distinct collapse identity", async () => {
  vi.useFakeTimers();
  const registry = new PushRegistry();
  const send = vi.fn(async (_registration: unknown, _notification: unknown) => "sent" as const);
  const broker = new RelayBroker(undefined, 10, new PushService(registry, { apns: { send } }), 100);
  brokers.push(broker);
  const a = socket(), b = socket();
  broker.register(a.ws, hello("desktop", "desktop-aaaa"));
  broker.register(b.ws, hello("desktop", "desktop-bbbb"));
  for (const id of ["desktop-aaaa", "desktop-bbbb"]) registry.upsert(`${"r".repeat(43)}:${id}`, {
    deviceId: "mobile-aaaa", platform: "apns", token: "t".repeat(64), environment: "production", updatedAt: 1,
  });
  broker.route(a.ws, { type: "push", desktopDeviceId: "desktop-bbbb", kind: "attention", collapseId: "7", nonce: "n".repeat(16), ciphertext: "c".repeat(22) });
  await Promise.resolve();
  expect(send).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ desktopDeviceId: "desktop-aaaa" }));
  send.mockClear();
  broker.disconnect(a.ws); broker.disconnect(b.ws);
  await vi.advanceTimersByTimeAsync(101);
  const notifications = send.mock.calls.map((call) => call[1] as { desktopDeviceId: string; collapseId: string });
  expect(notifications.map((n) => n.desktopDeviceId).sort()).toEqual(["desktop-aaaa", "desktop-bbbb"]);
  expect(new Set(notifications.map((n) => n.collapseId)).size).toBe(2);
  for (const n of notifications) expect(n.collapseId).toMatch(/^[a-f0-9]{64}$/);
});

it("claims persisted legacy registrations only when their phone binds a target, preserving newer scoped data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-legacy-push-"));
  try {
    const path = join(directory, "push.json");
    const roomId = "r".repeat(43);
    const legacy = { deviceId: "mobile-aaaa", platform: "apns" as const, token: "t".repeat(64), environment: "production" as const, updatedAt: 1 };
    const other = { ...legacy, deviceId: "mobile-bbbb", token: "u".repeat(64) };
    writeFileSync(path, JSON.stringify({ [roomId]: [legacy, other] }));
    const registry = new PushRegistry(path);
    const send = vi.fn(async () => "sent" as const);
    const broker = new RelayBroker(undefined, 10, new PushService(registry, { apns: { send } })); brokers.push(broker);
    const a = socket(), b = socket(), discovery = socket(), mobile = socket();
    broker.register(a.ws, hello("desktop", "desktop-aaaa"));
    broker.register(b.ws, hello("desktop", "desktop-bbbb"));
    broker.register(discovery.ws, hello("mobile", "mobile-aaaa"));
    expect(registry.list(roomId)).toHaveLength(2);
    broker.register(mobile.ws, hello("mobile", "mobile-aaaa", "desktop-bbbb"));
    expect(registry.list(`${roomId}:desktop-bbbb`)).toEqual([legacy]);
    expect(registry.list(`${roomId}:desktop-aaaa`)).toEqual([]);
    expect(new PushRegistry(path).list(roomId)).toEqual([other]);
    broker.route(mobile.ws, { type: "app_state", foreground: false });
    broker.route(b.ws, { type: "push", kind: "attention", collapseId: "9", nonce: "n".repeat(16), ciphertext: "c".repeat(22) });
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ token: legacy.token }), expect.objectContaining({ desktopDeviceId: "desktop-bbbb" }));
    registry.upsert(`${roomId}:desktop-aaaa`, { ...other, token: "new-token".repeat(8), updatedAt: 2 });
    broker.register(socket().ws, hello("mobile", "mobile-bbbb", "desktop-aaaa"));
    expect(registry.list(`${roomId}:desktop-aaaa`)[0].updatedAt).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8"))[roomId]).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
