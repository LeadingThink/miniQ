import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { MAX_MESSAGE_BYTES, RelayBroker } from "./broker.js";
import { configuredBlobStore, type TicketIssuer } from "./blobStore.js";
import { ShareStore } from "./shareStore.js";
import { ShareHttp, oneApiShareAuth } from "./shareHttp.js";
import { configuredPushService, type PushService } from "./push.js";

const DEFAULT_PORT = 9200;
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_ALLOWED_ORIGINS = [
  "https://oneapi.zaiwenai.com",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
  "tauri://localhost",
];

export function createRelayServer(options?: {
  allowedOrigins?: string[];
  blobs?: TicketIssuer;
  shares?: ShareHttp;
  desktopReconnectGraceMs?: number;
  push?: PushService;
  desktopOfflinePushMs?: number;
}): Server {
  const broker = new RelayBroker(
    options?.blobs ?? configuredBlobStore(),
    options?.desktopReconnectGraceMs,
    options?.push ?? configuredPushService(),
    options?.desktopOfflinePushMs ?? configuredOfflinePushMs(),
  );
  const allowedOrigins = new Set(options?.allowedOrigins ?? configuredOrigins());
  const shares = options?.shares ?? (process.env.MINIQ_SHARE_DIR ? new ShareHttp(new ShareStore(process.env.MINIQ_SHARE_DIR), oneApiShareAuth()) : undefined);
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/shares/")) {
      if (shares) void shares.handle(request, response);
      else response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "分享服务尚未启用" }));
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, rooms: broker.roomCount() }));
      return;
    }
    response.writeHead(404).end();
  });
  if (shares) {
    const cleanup = () => void shares.store.cleanup().catch(() => console.error("Share cleanup failed"));
    cleanup();
    const timer = setInterval(cleanup, 3600000).unref();
    server.on("close", () => clearInterval(timer));
  }
  server.on("close", () => broker.close());
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://relay.local").pathname;
    const origin = request.headers.origin;
    if (path !== "/ws" || (origin && !allowedOrigins.has(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket));
  });

  sockets.on("connection", (socket) => {
    let registered = false;
    let alive = true;
    const handshakeTimer = setTimeout(() => socket.close(4000, "hello timeout"), 10_000);
    socket.on("pong", () => { alive = true; });
    socket.on("message", (data, binary) => {
      if (binary) return socket.close(4000, "text frames only");
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        return socket.close(4000, "invalid json");
      }
      try {
        if (!registered) {
          registered = broker.register(socket, value);
          if (registered) clearTimeout(handshakeTimer);
        } else {
          broker.route(socket, value);
        }
      } catch (error) {
        console.error("[relay] message handler failed", error);
        socket.close(1011, "internal error");
      }
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      broker.disconnect(socket);
    });
    socket.on("error", () => {});
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
      // 15 s pings detect dead phones within ~30 s and stay well inside the
      // daemon's 75 s RELAY_IDLE_TIMEOUT, which any inbound ping resets.
    }, HEARTBEAT_INTERVAL_MS);
    socket.on("close", () => clearInterval(heartbeat));
  });
  return server;
}

function configuredOfflinePushMs(): number | undefined {
  const minutes = Number(process.env.MINIQ_DESKTOP_OFFLINE_PUSH_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined;
}

function configuredOrigins(): string[] {
  const configured = process.env.MINIQ_RELAY_ALLOWED_ORIGINS;
  return configured ? configured.split(",").map((origin) => origin.trim()).filter(Boolean) : DEFAULT_ALLOWED_ORIGINS;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  const port = Number(process.env.MINIQ_RELAY_PORT ?? DEFAULT_PORT);
  const host = process.env.MINIQ_RELAY_HOST ?? "127.0.0.1";
  createRelayServer().listen(port, host, () => {
    console.log(`miniq-relay listening on http://${host}:${port}`);
  });
}
