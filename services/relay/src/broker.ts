import { randomUUID, timingSafeEqual } from "node:crypto";
import type WebSocket from "ws";

const MAX_MOBILES_PER_ROOM = 8;
const MAX_MESSAGES_PER_MINUTE = 240;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export interface HelloMessage {
  type: "hello";
  protocol: number;
  role: "desktop" | "mobile";
  roomId: string;
  authToken: string;
  deviceId: string;
  deviceName: string;
}

interface FrameMessage {
  type: "frame";
  target: string;
  nonce: string;
  ciphertext: string;
}

interface Peer {
  id: string;
  role: "desktop" | "mobile";
  roomId: string;
  socket: WebSocket;
  windowStartedAt: number;
  messagesInWindow: number;
}

interface Room {
  authToken: string;
  desktop: Peer;
  mobiles: Map<string, Peer>;
}

export class RelayBroker {
  private readonly rooms = new Map<string, Room>();
  private readonly peers = new WeakMap<WebSocket, Peer>();

  register(socket: WebSocket, raw: unknown): boolean {
    const hello = parseHello(raw);
    if (!hello) {
      return this.reject(socket, "invalid_hello", "连接信息无效");
    }

    const existing = this.rooms.get(hello.roomId);
    if (hello.role === "desktop") {
      if (existing && !sameToken(existing.authToken, hello.authToken)) {
        return this.reject(socket, "unauthorized", "认证失败");
      }
      existing?.desktop.socket.close(4001, "desktop replaced");
      const peer = createPeer(socket, "desktop", hello.roomId, hello.deviceId);
      const room: Room = {
        authToken: hello.authToken,
        desktop: peer,
        mobiles: existing?.mobiles ?? new Map(),
      };
      this.rooms.set(hello.roomId, room);
      this.peers.set(socket, peer);
      send(socket, ready(peer.id, true, room.mobiles.size));
      this.broadcastPresence(room);
      return true;
    }

    if (!existing || existing.desktop.socket.readyState !== existing.desktop.socket.OPEN) {
      return this.reject(socket, "desktop_offline", "桌面端尚未在线");
    }
    if (!sameToken(existing.authToken, hello.authToken)) {
      return this.reject(socket, "unauthorized", "认证失败");
    }
    if (existing.mobiles.size >= MAX_MOBILES_PER_ROOM) {
      return this.reject(socket, "room_full", "已达到移动设备上限");
    }
    const peer = createPeer(socket, "mobile", hello.roomId, `mobile-${randomUUID()}`);
    existing.mobiles.set(peer.id, peer);
    this.peers.set(socket, peer);
    send(socket, ready(peer.id, true, existing.mobiles.size));
    this.broadcastPresence(existing);
    return true;
  }

  route(socket: WebSocket, raw: unknown): void {
    const peer = this.peers.get(socket);
    if (!peer) {
      this.reject(socket, "hello_required", "请先完成握手");
      return;
    }
    if (!consumeRateLimit(peer)) {
      this.reject(socket, "rate_limited", "消息过于频繁");
      return;
    }
    const frame = parseFrame(raw);
    if (!frame) {
      this.reject(socket, "invalid_frame", "加密消息格式无效");
      return;
    }
    const room = this.rooms.get(peer.roomId);
    if (!room) return;

    const forwarded = JSON.stringify({ ...frame, source: peer.id });
    if (peer.role === "mobile") {
      if (frame.target !== "desktop") {
        this.reject(socket, "invalid_target", "移动端只能向桌面端发送请求");
        return;
      }
      sendRaw(room.desktop.socket, forwarded);
      return;
    }

    if (frame.target === "mobiles") {
      for (const mobile of room.mobiles.values()) sendRaw(mobile.socket, forwarded);
      return;
    }
    const target = room.mobiles.get(frame.target);
    if (target) sendRaw(target.socket, forwarded);
  }

  disconnect(socket: WebSocket): void {
    const peer = this.peers.get(socket);
    if (!peer) return;
    const room = this.rooms.get(peer.roomId);
    if (!room) return;
    if (peer.role === "desktop" && room.desktop.socket === socket) {
      for (const mobile of room.mobiles.values()) {
        send(mobile.socket, { type: "presence", desktopOnline: false, mobileClients: 0 });
        mobile.socket.close(1012, "desktop offline");
      }
      this.rooms.delete(peer.roomId);
      return;
    }
    room.mobiles.delete(peer.id);
    this.broadcastPresence(room);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  private broadcastPresence(room: Room): void {
    const message = {
      type: "presence",
      desktopOnline: true,
      mobileClients: room.mobiles.size,
    };
    send(room.desktop.socket, message);
    for (const mobile of room.mobiles.values()) send(mobile.socket, message);
  }

  private reject(socket: WebSocket, code: string, message: string): false {
    send(socket, { type: "error", code, message });
    socket.close(4000, code);
    return false;
  }
}

function parseHello(raw: unknown): HelloMessage | null {
  if (!isObject(raw)) return null;
  if (raw.type !== "hello" || raw.protocol !== 1) return null;
  if (raw.role !== "desktop" && raw.role !== "mobile") return null;
  if (typeof raw.roomId !== "string" || !HASH_PATTERN.test(raw.roomId)) return null;
  if (typeof raw.authToken !== "string" || !HASH_PATTERN.test(raw.authToken)) return null;
  if (typeof raw.deviceId !== "string" || !DEVICE_PATTERN.test(raw.deviceId)) return null;
  if (typeof raw.deviceName !== "string" || raw.deviceName.trim().length === 0 || raw.deviceName.length > 80) return null;
  return raw as unknown as HelloMessage;
}

function parseFrame(raw: unknown): FrameMessage | null {
  if (!isObject(raw) || raw.type !== "frame") return null;
  if (typeof raw.target !== "string" || raw.target.length > 80) return null;
  if (typeof raw.nonce !== "string" || raw.nonce.length !== 16) return null;
  if (typeof raw.ciphertext !== "string" || raw.ciphertext.length < 22 || raw.ciphertext.length > 2_700_000) return null;
  return raw as unknown as FrameMessage;
}

function createPeer(socket: WebSocket, role: Peer["role"], roomId: string, id: string): Peer {
  return { id, role, roomId, socket, windowStartedAt: Date.now(), messagesInWindow: 0 };
}

function consumeRateLimit(peer: Peer): boolean {
  const now = Date.now();
  if (now - peer.windowStartedAt >= 60_000) {
    peer.windowStartedAt = now;
    peer.messagesInWindow = 0;
  }
  peer.messagesInWindow += 1;
  return peer.messagesInWindow <= MAX_MESSAGES_PER_MINUTE;
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ready(clientId: string, desktopOnline: boolean, mobileClients: number) {
  return { type: "ready", clientId, desktopOnline, mobileClients };
}

function send(socket: WebSocket, value: unknown): void {
  sendRaw(socket, JSON.stringify(value));
}

function sendRaw(socket: WebSocket, value: string): void {
  if (socket.readyState === socket.OPEN) socket.send(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
