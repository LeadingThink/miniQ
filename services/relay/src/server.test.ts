import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { createRelayServer } from "./server.js";

const servers: ReturnType<typeof createRelayServer>[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function identity(key: string) {
  const derive = (label: string) => createHash("sha256").update(label).update(Buffer.from([0])).update(key).digest("base64url");
  return { roomId: derive("miniq-relay-room-v1"), authToken: derive("miniq-relay-auth-v1") };
}

async function start() {
  const server = createRelayServer({ allowedOrigins: ["http://test.local"] });
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

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
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

function hello(role: "desktop" | "mobile", key = "sk-shared", deviceId = "device-1234") {
  return { type: "hello", protocol: 1, role, ...identity(key), deviceId, deviceName: role };
}

describe("miniQ relay", () => {
  it("requires an online desktop before a mobile can join", async () => {
    const mobile = await connect(await start());
    const response = nextJson(mobile);
    mobile.send(JSON.stringify(hello("mobile")));
    await expect(response).resolves.toMatchObject({ type: "error", code: "desktop_offline" });
  });

  it("rejects a different key without exposing either token", async () => {
    const url = await start();
    const desktop = await connect(url);
    desktop.send(JSON.stringify(hello("desktop")));
    await nextJson(desktop);
    const mobile = await connect(url);
    const response = nextJson(mobile);
    const forged = hello("mobile");
    forged.authToken = identity("sk-wrong").authToken;
    mobile.send(JSON.stringify(forged));
    await expect(response).resolves.toMatchObject({ type: "error", code: "unauthorized" });
  });

  it("routes opaque request and response frames without reading ciphertext", async () => {
    const url = await start();
    const desktop = await connect(url);
    desktop.send(JSON.stringify(hello("desktop")));
    await nextJson(desktop);
    const mobile = await connect(url);
    mobile.send(JSON.stringify(hello("mobile")));
    const mobileReady = await nextJson(mobile);
    expect(mobileReady.type).toBe("ready");

    const desktopFrame = nextType(desktop, "frame");
    mobile.send(JSON.stringify({ type: "frame", target: "desktop", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "opaque-ciphertext-value" }));
    const request = await desktopFrame;
    expect(request).toMatchObject({ type: "frame", target: "desktop", ciphertext: "opaque-ciphertext-value" });
    expect(request.source).toBe(mobileReady.clientId);

    const mobileFrame = nextType(mobile, "frame");
    desktop.send(JSON.stringify({ type: "frame", target: mobileReady.clientId, nonce: "BBBBBBBBBBBBBBBB", ciphertext: "opaque-response-ciphertext-value" }));
    await expect(mobileFrame).resolves.toMatchObject({ type: "frame", source: "device-1234", ciphertext: "opaque-response-ciphertext-value" });
  });

  it("rejects a second desktop with the same key without disrupting the active desktop", async () => {
    const url = await start();
    const activeDesktop = await connect(url);
    activeDesktop.send(JSON.stringify(hello("desktop", "sk-shared", "desktop-active")));
    await nextJson(activeDesktop);

    const mobile = await connect(url);
    mobile.send(JSON.stringify(hello("mobile")));
    await nextJson(mobile);

    const secondDesktop = await connect(url);
    const conflict = nextJson(secondDesktop);
    secondDesktop.send(JSON.stringify(hello("desktop", "sk-shared", "desktop-second")));
    await expect(conflict).resolves.toMatchObject({ type: "error", code: "desktop_conflict" });

    const activeFrame = nextType(activeDesktop, "frame");
    mobile.send(JSON.stringify({
      type: "frame",
      target: "desktop",
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "request-after-conflict",
    }));
    await expect(activeFrame).resolves.toMatchObject({
      type: "frame",
      ciphertext: "request-after-conflict",
    });
  });

  it("allows the same desktop device to reconnect without disconnecting mobiles", async () => {
    const url = await start();
    const firstDesktop = await connect(url);
    firstDesktop.send(JSON.stringify(hello("desktop", "sk-shared", "desktop-stable")));
    await nextJson(firstDesktop);

    const mobile = await connect(url);
    mobile.send(JSON.stringify(hello("mobile")));
    await nextJson(mobile);

    const reconnectedDesktop = await connect(url);
    const replaced = nextClose(firstDesktop);
    const ready = nextJson(reconnectedDesktop);
    reconnectedDesktop.send(JSON.stringify(hello("desktop", "sk-shared", "desktop-stable")));
    await expect(ready).resolves.toMatchObject({
      type: "ready",
      clientId: "desktop-stable",
      mobileClients: 1,
    });
    await replaced;

    const reconnectedFrame = nextType(reconnectedDesktop, "frame");
    mobile.send(JSON.stringify({
      type: "frame",
      target: "desktop",
      nonce: "BBBBBBBBBBBBBBBB",
      ciphertext: "request-after-reconnect",
    }));
    await expect(reconnectedFrame).resolves.toMatchObject({
      type: "frame",
      ciphertext: "request-after-reconnect",
    });
    expect(mobile.readyState).toBe(WebSocket.OPEN);
  });

  it("allows another desktop after the active desktop has disconnected", async () => {
    const url = await start();
    const firstDesktop = await connect(url);
    firstDesktop.send(JSON.stringify(hello("desktop", "sk-shared", "desktop-first")));
    await nextJson(firstDesktop);
    const disconnected = nextClose(firstDesktop);
    firstDesktop.close();
    await disconnected;

    const nextDesktop = await connect(url);
    const ready = nextJson(nextDesktop);
    nextDesktop.send(JSON.stringify(hello("desktop", "sk-shared", "desktop-next")));

    await expect(ready).resolves.toMatchObject({
      type: "ready",
      clientId: "desktop-next",
      desktopOnline: true,
    });
  });

  it("counts Unicode device names consistently with the desktop daemon", async () => {
    const url = await start();
    const desktop = await connect(url);
    const ready = nextJson(desktop);
    desktop.send(JSON.stringify({
      ...hello("desktop"),
      deviceName: "😀".repeat(80),
    }));

    await expect(ready).resolves.toMatchObject({ type: "ready", desktopOnline: true });
  });
});
