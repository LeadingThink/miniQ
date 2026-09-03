import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { RelayBroker } from "./broker.js";

const DEFAULT_PORT = 9200;
const DEFAULT_ALLOWED_ORIGINS = [
  "https://oneapi.zaiwenai.com",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
  "tauri://localhost",
];

export function createRelayServer(options?: { allowedOrigins?: string[] }): Server {
  const broker = new RelayBroker();
  const allowedOrigins = new Set(options?.allowedOrigins ?? configuredOrigins());
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, rooms: broker.roomCount() }));
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

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
      if (!registered) {
        registered = broker.register(socket, value);
        if (registered) clearTimeout(handshakeTimer);
      } else {
        broker.route(socket, value);
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
    }, 30_000);
    socket.on("close", () => clearInterval(heartbeat));
  });
  return server;
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
