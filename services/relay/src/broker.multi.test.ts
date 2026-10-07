import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";
import { createRelayServer } from "./server.js";
import { PushRegistry, PushService } from "./push.js";
import type { TicketIssuer } from "./blobStore.js";

const servers: ReturnType<typeof createRelayServer>[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function identity(key: string) {
  const derive = (label: string) => createHash("sha256").update(label).update(Buffer.from([0])).update(key).digest("base64url");
  return { roomId: derive("miniq-relay-room-v1"), authToken: derive("miniq-relay-auth-v1") };
}

async function start(blobs?: TicketIssuer, desktopReconnectGraceMs?: number, push?: PushService) {
  const server = createRelayServer({
    allowedOrigins: ["http://test.local"],
    blobs,
    push,
    desktopReconnectGraceMs,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `ws://127.0.0.1:${address.port}/ws`;
}

function connect(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { origin: "http://test.local" });
    socket.once("open", () => {
      clients.push(socket);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function nextType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: RawData) => {
      const value = JSON.parse(data.toString()) as Record<string, unknown>;
      if (value.type === type) {
        socket.off("message", onMessage);
        resolve(value);
      }
    };
    socket.on("message", onMessage);
  });
}

function nextClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function closeInfo(socket: WebSocket): Promise<[number, string]> {
  return new Promise((resolve) => socket.once("close", (code, reason) => resolve([code, reason.toString()])));
}

function collect(socket: WebSocket, type: string): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString()) as Record<string, unknown>;
    if (value.type === type) seen.push(value);
  });
  return seen;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function joined(url: string, desktopId = "desktop-1234") {
  const desktop = await connect(url);
  desktop.send(JSON.stringify(hello("desktop", "sk-shared", desktopId)));
  await nextType(desktop, "ready");
  const mobile = await connect(url);
  const ready = nextType(mobile, "ready");
  mobile.send(JSON.stringify(hello("mobile")));
  return { desktop, mobile, mobileReady: await ready };
}

function frame(target: string, ciphertext = "opaque-ciphertext-value") {
  return JSON.stringify({ type: "frame", target, nonce: "AAAAAAAAAAAAAAAA", ciphertext });
}

function hello(role: "desktop" | "mobile", key = "sk-shared", deviceId = "device-1234") {
  return { type: "hello", protocol: 1, role, ...identity(key), deviceId, deviceName: role };
}

async function joinV2(url: string, role: "desktop" | "mobile", deviceId: string, targetDeviceId?: string) {
  const socket = await connect(url);
  const response = nextType(socket, role === "mobile" && !targetDeviceId ? "devices" : "ready");
  socket.send(JSON.stringify({ ...hello(role, "sk-shared", deviceId), protocol: 2, targetDeviceId }));
  return { socket, response: await response };
}

describe("multi-device relay over real WebSockets", () => {
  it("isolates approval frames, directed replies, broadcasts and presence", async () => {
    const url = await start();
    const a = await joinV2(url, "desktop", "desktop-aaaa");
    const b = await joinV2(url, "desktop", "desktop-bbbb");
    const ma = await joinV2(url, "mobile", "mobile-aaaa", "desktop-aaaa");
    const bPresence = collect(b.socket, "presence");
    const mb = await joinV2(url, "mobile", "mobile-bbbb", "desktop-bbbb");
    expect(ma.response).toMatchObject({ desktopDeviceId: "desktop-aaaa", deviceName: "desktop", mobileClients: 1 });
    const bFrames = collect(b.socket, "frame");
    const mbFrames = collect(mb.socket, "frame");
    const approval = nextType(a.socket, "frame");
    ma.socket.send(frame("desktop", "encrypted-approval-for-desktop-aaaa"));
    await expect(approval).resolves.toMatchObject({ source: ma.response.clientId });
    const reply = nextType(ma.socket, "frame");
    a.socket.send(frame("mobiles", "encrypted-task-event-from-desktop-aaaa"));
    await reply;
    a.socket.send(frame(mb.response.clientId as string, "encrypted-cross-device-reply-denied"));
    await wait(25);
    expect(bFrames).toEqual([]);
    expect(mbFrames).toEqual([]);
    expect(bPresence).toHaveLength(1);
    expect(bPresence[0]).toMatchObject({ mobileIds: [mb.response.clientId], mobileClients: 1 });
  });

  it("discovers retained offline metadata and never routes an offline target to another desktop", async () => {
    const url = await start(undefined, 10);
    const discover = await joinV2(url, "mobile", "mobile-scan");
    expect(discover.response).toEqual({ type: "devices", devices: [] });
    const devices = nextType(discover.socket, "devices");
    const a = await joinV2(url, "desktop", "desktop-aaaa");
    await expect(devices).resolves.toMatchObject({ devices: [{ deviceId: "desktop-aaaa", online: true }] });
    const b = await joinV2(url, "desktop", "desktop-bbbb");
    const closed = nextClose(a.socket);
    a.socket.close();
    await closed;
    await wait(25);
    const scan = await joinV2(url, "mobile", "mobile-scan2");
    expect(scan.response.devices).toEqual([
      { deviceId: "desktop-aaaa", deviceName: "desktop", online: false },
      { deviceId: "desktop-bbbb", deviceName: "desktop", online: true },
    ]);
    const ma = await joinV2(url, "mobile", "mobile-aaaa", "desktop-aaaa");
    expect(ma.response).toMatchObject({ desktopOnline: false, desktopDeviceId: "desktop-aaaa" });
    const wrong = collect(b.socket, "frame");
    ma.socket.send(frame("desktop", "encrypted-offline-target-approval"));
    await wait(20);
    expect(wrong).toEqual([]);
    const a2 = await joinV2(url, "desktop", "desktop-aaaa");
    expect(a2.response.mobileClients).toBe(1);
    const correct = nextType(a2.socket, "frame");
    ma.socket.send(frame("desktop", "encrypted-reconnected-target-approval"));
    await correct;
  });

  it("rejects discovery business traffic, unknown/malformed targets and ambiguous legacy clients", async () => {
    const url = await start();
    await joinV2(url, "desktop", "desktop-aaaa");
    const discovery = await joinV2(url, "mobile", "mobile-scan");
    const error = nextType(discovery.socket, "error");
    discovery.socket.send(frame("desktop"));
    await expect(error).resolves.toMatchObject({ code: "device_selection_required" });
    const legacy = await connect(url);
    const ready = nextType(legacy, "ready");
    legacy.send(JSON.stringify(hello("mobile")));
    await expect(ready).resolves.toMatchObject({ desktopDeviceId: "desktop-aaaa" });
    await joinV2(url, "desktop", "desktop-bbbb");
    for (const [protocol, targetDeviceId, code] of [
      [1, undefined, "device_selection_required"],
      [2, "desktop-missing", "invalid_target"],
      [2, "bad/id", "invalid_hello"],
    ] as const) {
      const mobile = await connect(url);
      const rejected = nextType(mobile, "error");
      mobile.send(JSON.stringify({ ...hello("mobile"), protocol, targetDeviceId }));
      await expect(rejected).resolves.toMatchObject({ code });
    }
  });

  it("issues independent blob scopes only to each desktop and never broadcasts tickets", async () => {
    const ticket = vi.fn(async (_room: string, _bytes: number, deviceId?: string) => ({
      putUrl: `https://objects.test/${deviceId}/put`, getUrl: `https://objects.test/${deviceId}/get`, expiresAt: Date.now() + 300000,
    }));
    const url = await start({ enabledFor: () => true, ticket });
    const a = await joinV2(url, "desktop", "desktop-aaaa");
    const b = await joinV2(url, "desktop", "desktop-bbbb");
    const ma = await joinV2(url, "mobile", "mobile-aaaa", "desktop-aaaa");
    const observed = collect(ma.socket, "blob_ticket");
    for (const [desktop, id] of [[a.socket, "desktop-aaaa"], [b.socket, "desktop-bbbb"]] as const) {
      const response = nextType(desktop, "blob_ticket");
      desktop.send(JSON.stringify({ type: "blob_ticket", requestId: "same-request", bytes: 1024 }));
      await expect(response).resolves.toMatchObject({ ticket: { getUrl: `https://objects.test/${id}/get` } });
      expect(ticket).toHaveBeenCalledWith(identity("sk-shared").roomId, 1024, id);
    }
    expect(observed).toEqual([]);
  });
});


it("acknowledges the bound push target and rejects mismatched targets over WebSocket", async () => {
  const registry = new PushRegistry();
  const push = new PushService(registry, { apns: { send: async () => "sent" as const } });
  const url = await start(undefined, undefined, push);
  await joinV2(url, "desktop", "desktop-aaaa");
  await joinV2(url, "desktop", "desktop-bbbb");
  const mobile = await joinV2(url, "mobile", "mobile-aaaa", "desktop-aaaa");
  const registration = { type: "push_register", platform: "apns", token: "a".repeat(64), environment: "production" };
  for (const target of [{}, { targetDeviceId: "desktop-aaaa" }]) {
    const ack = nextType(mobile.socket, "push_registered");
    mobile.socket.send(JSON.stringify({ ...registration, ...target }));
    await expect(ack).resolves.toMatchObject({ type: "push_registered", enabled: true, targetDeviceId: "desktop-aaaa" });
  }
  const roomId = identity("sk-shared").roomId;
  expect(registry.list(`${roomId}:desktop-aaaa`)).toHaveLength(1);
  const acknowledgements = collect(mobile.socket, "push_registered");
  const error = nextType(mobile.socket, "error");
  const closed = closeInfo(mobile.socket);
  mobile.socket.send(JSON.stringify({ ...registration, token: "b".repeat(64), targetDeviceId: "desktop-bbbb" }));
  await expect(error).resolves.toMatchObject({ code: "invalid_target" });
  expect((await closed)[0]).toBe(4000);
  expect(acknowledgements).toEqual([]);
  expect(registry.list(`${roomId}:desktop-aaaa`)[0].token).toBe(registration.token);
  expect(registry.list(`${roomId}:desktop-bbbb`)).toEqual([]);
});
