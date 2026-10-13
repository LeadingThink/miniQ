import { afterEach, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { MAX_BLOB_BYTES, MAX_PROVIDER_MEDIA_BYTES, type BlobTicket, type TicketIssuer } from "./blobStore.js";
import { RelayBroker } from "./broker.js";
import { ObjectByteBudget } from "./rateLimit.js";

const roomId = "r".repeat(43);
const brokers: RelayBroker[] = [];
const issued: BlobTicket = { putUrl: "https://objects.test/put", getUrl: "https://objects.test/get", expiresAt: 900000 };
const request = { type: "provider_media_ticket", requestId: "media-1", bytes: 1024, contentType: "image/png" };
afterEach(() => { brokers.splice(0).forEach((broker) => broker.close()); vi.useRealTimers(); });
function socket() {
  const messages: Record<string, unknown>[] = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: vi.fn((data: string) => messages.push(JSON.parse(data))), close: vi.fn() };
  return { ws: ws as unknown as WebSocket, messages };
}
function hello(role: "desktop" | "mobile", deviceId = "desktop-aaaa", targetDeviceId?: string) {
  return { type: "hello", protocol: 2, roomId, authToken: "a".repeat(43), role, deviceId, deviceName: deviceId, targetDeviceId };
}
function setup(overrides: Partial<TicketIssuer> = {}) {
  const ticket = vi.fn(async () => issued);
  const providerMediaTicket = vi.fn(async () => issued);
  const broker = new RelayBroker({ enabledFor: () => true, ticket, providerMediaTicket, ...overrides });
  brokers.push(broker);
  const desktop = socket();
  broker.register(desktop.ws, hello("desktop"));
  desktop.messages.length = 0;
  return { broker, desktop, ticket, providerMediaTicket };
}

it("issues only to the authenticated desktop, taking room/device scope from its peer", async () => {
  const { broker, desktop, ticket, providerMediaTicket } = setup();
  const mobile = socket(), other = socket(), unregistered = socket(), unauthorized = socket();
  broker.register(mobile.ws, hello("mobile", "mobile-aaaa", "desktop-aaaa"));
  broker.register(other.ws, hello("desktop", "desktop-bbbb"));
  expect(broker.register(unauthorized.ws, { ...hello("desktop", "desktop-cccc"), authToken: "b".repeat(43) })).toBe(false);
  mobile.messages.length = 0; other.messages.length = 0; desktop.messages.length = 0;
  broker.route(unregistered.ws, request);
  broker.route(unauthorized.ws, request);
  broker.route(mobile.ws, request);
  await Promise.resolve();
  expect(providerMediaTicket).not.toHaveBeenCalled();
  expect(mobile.messages).toEqual([{ type: "provider_media_ticket", requestId: "media-1", error: "Provider media transfer unavailable" }]);
  mobile.messages.length = 0;
  broker.route(desktop.ws, { ...request, roomId: "attacker-room", desktopDeviceId: "desktop-bbbb" });
  await Promise.resolve();
  expect(providerMediaTicket).toHaveBeenCalledExactlyOnceWith(roomId, 1024, "image/png", "desktop-aaaa");
  expect(ticket).not.toHaveBeenCalled();
  expect(desktop.messages).toEqual([{ type: "provider_media_ticket", requestId: "media-1", ticket: issued }]);
  expect(mobile.messages).toEqual([]);
  expect(other.messages).toEqual([]);
  expect(unregistered.messages).toEqual([]);
});

it.each([
  { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }, { bytes: "1024" }, { bytes: Number.MAX_SAFE_INTEGER },
  { bytes: MAX_PROVIDER_MEDIA_BYTES + 1 }, { contentType: "application/octet-stream" },
  { contentType: "image/svg+xml" }, { contentType: "IMAGE/PNG" }, { contentType: "image/png; charset=utf-8" },
  { contentType: null },
])("rejects invalid provider-media fields before issuing or reserving: %j", async (invalid) => {
  const { broker, desktop, providerMediaTicket } = setup();
  broker.route(desktop.ws, { ...request, ...invalid });
  await Promise.resolve();
  expect(desktop.messages[0]).toMatchObject({ error: "Provider media transfer unavailable" });
  expect(providerMediaTicket).not.toHaveBeenCalled();
  broker.route(desktop.ws, { ...request, bytes: MAX_PROVIDER_MEDIA_BYTES });
  await Promise.resolve();
  expect(providerMediaTicket).toHaveBeenCalledExactlyOnceWith(roomId, MAX_PROVIDER_MEDIA_BYTES, "image/png", "desktop-aaaa");
});

it.each([undefined, 123, "", "x".repeat(81)])("ignores invalid provider-media request IDs: %j", async (requestId) => {
  const { broker, desktop, providerMediaTicket } = setup();
  broker.route(desktop.ws, { ...request, requestId });
  await Promise.resolve();
  expect(providerMediaTicket).not.toHaveBeenCalled();
  expect(desktop.messages).toEqual([]);
});

it("enforces separate per-device media budgets, preserving existing blob tickets and allowing renewal", async () => {
  vi.useFakeTimers();
  const { broker, desktop, ticket, providerMediaTicket } = setup();
  const other = socket(); broker.register(other.ws, hello("desktop", "desktop-bbbb"));
  broker.route(desktop.ws, { ...request, bytes: MAX_PROVIDER_MEDIA_BYTES });
  broker.route(desktop.ws, request);
  broker.route(other.ws, { ...request, bytes: MAX_PROVIDER_MEDIA_BYTES });
  broker.route(desktop.ws, { type: "blob_ticket", requestId: "encrypted", bytes: MAX_BLOB_BYTES });
  await Promise.resolve();
  expect(providerMediaTicket).toHaveBeenCalledTimes(2);
  expect(ticket).toHaveBeenCalledExactlyOnceWith(roomId, MAX_BLOB_BYTES, "desktop-aaaa");
  expect(desktop.messages).toContainEqual({ type: "blob_ticket", requestId: "encrypted", ticket: issued });
  expect(desktop.messages).toContainEqual(expect.objectContaining({ type: "provider_media_ticket", error: "Provider media transfer unavailable" }));
  vi.advanceTimersByTime(60000);
  broker.route(desktop.ws, { ...request, bytes: MAX_PROVIDER_MEDIA_BYTES });
  await Promise.resolve();
  expect(providerMediaTicket).toHaveBeenCalledTimes(3);
});

it("releases failed issuance reservations and hides SDK error details", async () => {
  const providerMediaTicket = vi.fn(async () => issued).mockRejectedValueOnce(new Error("secret-access-key signed-url"));
  const ticket = vi.fn(async () => issued).mockRejectedValueOnce(new Error("secret"));
  const { broker, desktop } = setup({ providerMediaTicket, ticket });
  broker.route(desktop.ws, { ...request, bytes: MAX_PROVIDER_MEDIA_BYTES });
  broker.route(desktop.ws, { type: "blob_ticket", requestId: "failed-blob", bytes: MAX_BLOB_BYTES });
  await Promise.resolve();
  broker.route(desktop.ws, { ...request, bytes: MAX_PROVIDER_MEDIA_BYTES });
  for (let i = 0; i < 2; i++) broker.route(desktop.ws, { type: "blob_ticket", requestId: `blob-${i}`, bytes: MAX_BLOB_BYTES });
  await Promise.resolve();
  expect(providerMediaTicket).toHaveBeenCalledTimes(2);
  expect(ticket).toHaveBeenCalledTimes(3);
  expect(desktop.messages).toContainEqual(expect.objectContaining({ type: "provider_media_ticket", ticket: issued }));
  expect(JSON.stringify(desktop.messages)).not.toContain("secret");
});

it("supports legacy ticket issuers without the optional provider-media method", async () => {
  const { broker, desktop, ticket } = setup({ providerMediaTicket: undefined });
  broker.route(desktop.ws, request);
  broker.route(desktop.ws, { type: "blob_ticket", requestId: "legacy", bytes: 1024 });
  await Promise.resolve();
  expect(desktop.messages).toContainEqual(expect.objectContaining({ type: "provider_media_ticket", error: "Provider media transfer unavailable" }));
  expect(desktop.messages).toContainEqual({ type: "blob_ticket", requestId: "legacy", ticket: issued });
  expect(ticket).toHaveBeenCalledExactlyOnceWith(roomId, 1024, "desktop-aaaa");
});

it("revokes stale desktop requests and suppresses their pending provider-media response", async () => {
  let resolve!: (ticket: BlobTicket) => void;
  const providerMediaTicket = vi.fn(() => new Promise<BlobTicket>((done) => { resolve = done; }));
  const { broker, desktop } = setup({ providerMediaTicket });
  broker.route(desktop.ws, request);
  const replacement = socket(); broker.register(replacement.ws, hello("desktop"));
  desktop.messages.length = 0;
  broker.route(desktop.ws, request);
  resolve(issued);
  await Promise.resolve();
  expect(providerMediaTicket).toHaveBeenCalledTimes(1);
  expect(desktop.messages).toEqual([]);
  broker.route(replacement.ws, request);
  expect(providerMediaTicket).toHaveBeenCalledTimes(2);
});

it("releases each reservation at most once and never subtracts from a newer minute", () => {
  const budget = new ObjectByteBudget(0, 256);
  const failed = budget.reservation(256, 0)!;
  expect(budget.reservation(1, 0)).toBeUndefined();
  failed.release(); failed.release();
  const old = budget.reservation(256, 1)!;
  expect(budget.reservation(1, 1)).toBeUndefined();
  expect(budget.reservation(256, 60000)).toBeDefined();
  old.release();
  expect(budget.reservation(1, 60000)).toBeUndefined();
});

it("advertises provider media support only for allowlisted rooms and capable issuers", () => {
  for (const [enabled, media, expected] of [[true, true, true], [false, true, false], [true, false, false]] as const) {
    const broker = new RelayBroker({ enabledFor: (room) => enabled && room === roomId, ticket: async () => issued,
      providerMediaTicket: media ? async () => issued : undefined });
    brokers.push(broker);
    const desktop = socket();
    broker.register(desktop.ws, hello("desktop"));
    expect(desktop.messages[0]).toMatchObject({ type: "ready", blobStorage: enabled, providerMediaStorage: expected });
  }
});

it("does not treat a new arbitrary room handshake as storage or account authorization", async () => {
  const { broker, providerMediaTicket } = setup({ enabledFor: (room) => room === roomId });
  const desktop = socket();
  expect(broker.register(desktop.ws, { ...hello("desktop"), roomId: "s".repeat(43) })).toBe(true);
  expect(desktop.messages[0]).toMatchObject({ type: "ready", providerMediaStorage: false });
  broker.route(desktop.ws, request);
  await Promise.resolve();
  expect(providerMediaTicket).not.toHaveBeenCalled();
  expect(desktop.messages).toContainEqual(expect.objectContaining({ type: "provider_media_ticket", error: "Provider media transfer unavailable" }));
});

it("permits a 200 MB object but preserves the finite device budget across reconnects and goodbye", async () => {
  const { broker, desktop, providerMediaTicket } = setup();
  broker.route(desktop.ws, { ...request, bytes: 200_000_000 });
  await Promise.resolve();
  expect(desktop.messages).toContainEqual({ type: "provider_media_ticket", requestId: "media-1", ticket: issued });
  const replacement = socket();
  broker.register(replacement.ws, hello("desktop"));
  broker.route(replacement.ws, { ...request, bytes: 200_000_000 });
  await Promise.resolve();
  expect(providerMediaTicket).toHaveBeenCalledTimes(1);
  expect(replacement.messages).toContainEqual(expect.objectContaining({ error: "Provider media transfer unavailable" }));
  broker.route(replacement.ws, { type: "desktop_goodbye" });
  const returned = socket();
  broker.register(returned.ws, hello("desktop"));
  broker.route(returned.ws, { ...request, bytes: 200_000_000 });
  await Promise.resolve();
  expect(providerMediaTicket).toHaveBeenCalledTimes(1);
});
