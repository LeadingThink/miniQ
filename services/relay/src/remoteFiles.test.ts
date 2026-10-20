import { afterEach, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { MAX_REMOTE_FILE_BYTES, type BlobTicket, type TicketIssuer } from "./blobStore.js";
import { RelayBroker } from "./broker.js";

const roomId = "r".repeat(43);
const brokers: RelayBroker[] = [];
const issued: BlobTicket = { putUrl: "https://objects.test/put", getUrl: "https://objects.test/get", expiresAt: 900000 };
const request = { type: "file_ticket", requestId: "file-1", bytes: 1024, sessionId: "session-1" };
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
  const remoteFileTicket = vi.fn(async () => issued);
  const broker = new RelayBroker({ enabledFor: () => true, ticket: async () => issued, remoteFileTicket, ...overrides });
  brokers.push(broker);
  const desktop = socket(); broker.register(desktop.ws, hello("desktop"));
  expect(desktop.messages[0]).toMatchObject({ fileStorage: (overrides.fileStorageEnabledFor?.(roomId) ?? ("remoteFileTicket" in overrides ? Boolean(overrides.remoteFileTicket) : true)) });
  desktop.messages.length = 0;
  return { broker, desktop, remoteFileTicket };
}

it("does not inherit the provider-media room allowlist", async () => {
  const { broker, desktop, remoteFileTicket } = setup({ enabledFor: () => false, fileStorageEnabledFor: () => true });
  broker.route(desktop.ws, request);
  await Promise.resolve();
  expect(remoteFileTicket).toHaveBeenCalledExactlyOnceWith(roomId, 1024, "desktop-aaaa", "session-1");
});it("issues only to the authenticated current desktop and ignores caller URL/target overrides", async () => {
  const { broker, desktop, remoteFileTicket } = setup();
  const mobile = socket(), other = socket(), unknown = socket(), unauthorized = socket();
  broker.register(mobile.ws, hello("mobile", "mobile-aaaa", "desktop-aaaa"));
  broker.register(other.ws, hello("desktop", "desktop-bbbb"));
  expect(broker.register(unauthorized.ws, { ...hello("desktop", "desktop-cccc"), authToken: "b".repeat(43) })).toBe(false);
  mobile.messages.length = 0; other.messages.length = 0; desktop.messages.length = 0;
  for (const peer of [mobile, unknown, unauthorized]) broker.route(peer.ws, request);
  expect(remoteFileTicket).not.toHaveBeenCalled();
  expect(mobile.messages).toEqual([{ type: "file_ticket_result", requestId: "file-1", error: "File transfer unavailable", code: "file_ticket_forbidden" }]);
  broker.route(desktop.ws, { ...request, roomId: "evil", desktopDeviceId: "desktop-bbbb", getUrl: "https://evil.test", key: "evil" });
  await Promise.resolve();
  expect(remoteFileTicket).toHaveBeenCalledExactlyOnceWith(roomId, 1024, "desktop-aaaa", "session-1");
  expect(desktop.messages).toEqual([{ type: "file_ticket_result", requestId: "file-1", ticket: issued }]);
  expect(other.messages).toEqual([]); expect(unknown.messages).toEqual([]);
});

it("accepts a first-file request from installed daemons that serialize no object as null", async () => {
  const { broker, desktop, remoteFileTicket } = setup();
  broker.route(desktop.ws, { ...request, objectId: null });
  await Promise.resolve();
  expect(remoteFileTicket).toHaveBeenCalledExactlyOnceWith(roomId, 1024, "desktop-aaaa", "session-1");
  expect(desktop.messages).toEqual([{ type: "file_ticket_result", requestId: "file-1", ticket: issued }]);
});

it("distinguishes an invalid request, disabled storage, a full budget, and signer failure", async () => {
  vi.useFakeTimers();
  const normal = setup();
  normal.broker.route(normal.desktop.ws, { ...request, objectId: "invalid" });
  expect(normal.desktop.messages[0]).toMatchObject({ code: "file_ticket_invalid" });
  const disabled = setup({ fileStorageEnabledFor: () => false });
  disabled.broker.route(disabled.desktop.ws, request);
  expect(disabled.desktop.messages[0]).toMatchObject({ code: "file_storage_unavailable" });
  normal.broker.route(normal.desktop.ws, { ...request, bytes: MAX_REMOTE_FILE_BYTES });
  await Promise.resolve();
  normal.broker.route(normal.desktop.ws, request);
  expect(normal.desktop.messages.at(-1)).toMatchObject({ code: "file_budget_exceeded", retryAfterMs: 60000 });
  const failed = setup({ remoteFileTicket: async () => { throw new Error("private signed URL"); } });
  failed.broker.route(failed.desktop.ws, request);
  await Promise.resolve();
  expect(failed.desktop.messages[0]).toMatchObject({ code: "file_storage_failed" });
  expect(JSON.stringify(failed.desktop.messages)).not.toContain("private signed URL");
});

it.each([{ bytes: -1 }, { bytes: 1.5 }, { bytes: "1" }, { bytes: MAX_REMOTE_FILE_BYTES + 1 }, { bytes: Infinity },
  { sessionId: "" }, { sessionId: " " }, { sessionId: null }, { sessionId: "x".repeat(257) }, { sessionId: "a\nb" }])("rejects malformed fields %j", async (invalid) => {
  const { broker, desktop, remoteFileTicket } = setup();
  broker.route(desktop.ws, { ...request, ...invalid }); await Promise.resolve();
  expect(remoteFileTicket).not.toHaveBeenCalled();
  expect(desktop.messages[0]).toMatchObject({ error: "File transfer unavailable" });
});
it.each([undefined, 123, "", "x".repeat(81)])("ignores malformed requestId %s", (requestId) => {
  const { broker, desktop, remoteFileTicket } = setup();
  broker.route(desktop.ws, { ...request, requestId });
  expect(remoteFileTicket).not.toHaveBeenCalled(); expect(desktop.messages).toEqual([]);
});
it.each([{ remoteFileTicket: undefined }, { fileStorageEnabledFor: () => false }])("disables unavailable storage", async (overrides) => {
  const { broker, desktop, remoteFileTicket } = setup(overrides);
  broker.route(desktop.ws, request); await Promise.resolve();
  expect(remoteFileTicket).not.toHaveBeenCalled(); expect(desktop.messages[0]).toMatchObject({ error: "File transfer unavailable" });
});
it("allows zero and max bytes, keeps quotas across reconnect, and renews after one minute", async () => {
  vi.useFakeTimers();
  const { broker, desktop, remoteFileTicket } = setup();
  broker.route(desktop.ws, { ...request, bytes: 0 });
  broker.route(desktop.ws, { ...request, bytes: MAX_REMOTE_FILE_BYTES });
  await Promise.resolve(); expect(remoteFileTicket).toHaveBeenCalledTimes(2);
  const replacement = socket(); broker.register(replacement.ws, hello("desktop"));
  broker.route(replacement.ws, request); await Promise.resolve();
  expect(remoteFileTicket).toHaveBeenCalledTimes(2);
  expect(replacement.messages).toContainEqual(expect.objectContaining({ error: "File transfer unavailable" }));
  const other = socket(); broker.register(other.ws, hello("desktop", "desktop-bbbb"));
  broker.route(other.ws, { ...request, bytes: MAX_REMOTE_FILE_BYTES });
  vi.advanceTimersByTime(60000);
  broker.route(replacement.ws, { ...request, bytes: MAX_REMOTE_FILE_BYTES });
  await Promise.resolve(); expect(remoteFileTicket).toHaveBeenCalledTimes(4);
});
it("refunds failed signing and hides secret error details", async () => {
  const remoteFileTicket = vi.fn(async () => issued).mockRejectedValueOnce(new Error("secret URL"));
  const { broker, desktop } = setup({ remoteFileTicket });
  broker.route(desktop.ws, { ...request, bytes: MAX_REMOTE_FILE_BYTES }); await Promise.resolve();
  broker.route(desktop.ws, { ...request, bytes: MAX_REMOTE_FILE_BYTES }); await Promise.resolve();
  expect(remoteFileTicket).toHaveBeenCalledTimes(2);
  expect(desktop.messages).toContainEqual({ type: "file_ticket_result", requestId: "file-1", ticket: issued });
  expect(JSON.stringify(desktop.messages)).not.toContain("secret");
});
it("suppresses pending results and subsequent requests from replaced desktops", async () => {
  let resolve!: (ticket: BlobTicket) => void;
  const remoteFileTicket = vi.fn(() => new Promise<BlobTicket>((done) => { resolve = done; }));
  const { broker, desktop } = setup({ remoteFileTicket });
  broker.route(desktop.ws, request);
  broker.register(socket().ws, hello("desktop")); desktop.messages.length = 0;
  broker.route(desktop.ws, request); resolve(issued); await Promise.resolve();
  expect(remoteFileTicket).toHaveBeenCalledTimes(1); expect(desktop.messages).toEqual([]);
});
