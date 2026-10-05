import { randomUUID, timingSafeEqual } from "node:crypto";
import type WebSocket from "ws";
import { MAX_BLOB_BYTES, type TicketIssuer } from "./blobStore.js";
import { send, sendRaw } from "./outbound.js";
import { parsePush, parseRegistration, type PushService } from "./push.js";
import { DESKTOP_RATE, DropCounter, MOBILE_RATE, ObjectByteBudget, TokenBucket } from "./rateLimit.js";

const MAX_MOBILES_PER_ROOM = 8;
// Daemon chunks are 768 KiB of plaintext (~1 MiB base64 ciphertext); 2 MiB
// leaves headroom. The WebSocket payload limit adds room for the JSON envelope
// so oversize ciphertext gets an explicit `frame_too_large` instead of 1009.
export const MAX_CIPHERTEXT_CHARS = 2 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = MAX_CIPHERTEXT_CHARS + 16 * 1024;
// A desktop relay socket can drop briefly during Wi-Fi/TLS changes. Keep
// mobile sockets in place while the same room reconnects instead of forcing
// every phone to restart its session for a transient transport event.
const DESKTOP_RECONNECT_GRACE_MS = 15_000;
// Phones get one "desktop is offline" push when the desktop stays away this long
// without saying goodbye (sleep, crash, network loss).
const DESKTOP_OFFLINE_PUSH_MS = 5 * 60_000;
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
  connectionId: string;
  role: "desktop" | "mobile";
  roomId: string;
  /** Stable client device id from hello (the routing id of mobiles is random per connection). */
  deviceId: string;
  /** Mobiles report whether the app is visible; background clients still need system pushes. */
  foreground: boolean;
  socket: WebSocket;
  messages: TokenBucket;
  objectBytes: ObjectByteBudget;
  drops: DropCounter;
}

interface Room {
  authToken: string;
  desktop: Peer;
  mobiles: Map<string, Peer>;
}

export class RelayBroker {
  private readonly rooms = new Map<string, Room>();
  private readonly peers = new WeakMap<WebSocket, Peer>();
  private readonly desktopDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly desktopOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly blobs?: TicketIssuer,
    private readonly desktopReconnectGraceMs = DESKTOP_RECONNECT_GRACE_MS,
    private readonly push?: PushService,
    private readonly desktopOfflinePushMs = DESKTOP_OFFLINE_PUSH_MS,
  ) {}

  close(): void {
    for (const timer of this.desktopDisconnectTimers.values()) clearTimeout(timer);
    for (const timer of this.desktopOfflineTimers.values()) clearTimeout(timer);
    this.desktopDisconnectTimers.clear();
    this.desktopOfflineTimers.clear();
    this.push?.close();
  }

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
      if (
        existing &&
        existing.desktop.socket.readyState === existing.desktop.socket.OPEN &&
        existing.desktop.id !== hello.deviceId
      ) {
        return this.reject(
          socket,
          "desktop_conflict",
          "同一个 Key 已有另一台桌面在线，请先在那台电脑上关闭远程访问",
        );
      }
      this.clearDesktopTimers(hello.roomId);
      existing?.desktop.socket.close(4001, "desktop reconnected");
      const peer = createPeer(socket, "desktop", hello.roomId, hello.deviceId, hello.deviceId);
      const room: Room = {
        authToken: hello.authToken,
        desktop: peer,
        mobiles: existing?.mobiles ?? new Map(),
      };
      this.rooms.set(hello.roomId, room);
      this.peers.set(socket, peer);
      send(socket, { ...ready(peer.id, true, room.mobiles.size), blobStorage: this.blobs?.enabledFor(peer.roomId) ?? false });
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
    const peer = createPeer(socket, "mobile", hello.roomId, `mobile-${randomUUID()}`, hello.deviceId);
    existing.mobiles.set(peer.id, peer);
    this.peers.set(socket, peer);
    send(socket, { ...ready(peer.id, true, existing.mobiles.size), desktopConnectionId: existing.desktop.connectionId });
    this.broadcastPresence(existing);
    return true;
  }

  route(socket: WebSocket, raw: unknown): void {
    const peer = this.peers.get(socket);
    if (!peer) {
      this.reject(socket, "hello_required", "请先完成握手");
      return;
    }
    if (!peer.messages.take()) {
      // The daemon treats any `error` as fatal and reconnects, which would turn
      // a burst into a reconnect loop; drop excess desktop messages instead.
      if (peer.role === "desktop") peer.drops.record(`desktop room ${peer.roomId.slice(0, 8)}`);
      else this.reject(socket, "rate_limited", "消息过于频繁");
      return;
    }
    if (isObject(raw) && raw.type === "blob_ticket") {
      void this.objectTicket(peer, raw);
      return;
    }
    if (isObject(raw) && typeof raw.type === "string" && this.control(peer, raw)) return;
    const frame = parseFrame(raw);
    if (frame === "too_large") {
      this.reject(socket, "frame_too_large", `加密消息超过 ${MAX_CIPHERTEXT_CHARS} 字符上限`);
      return;
    }
    if (!frame) {
      this.reject(socket, "invalid_frame", "加密消息格式无效");
      return;
    }
    const room = this.rooms.get(peer.roomId);
    if (!room) return;
    if (peer.role === "desktop" && room.desktop.socket !== socket) return;

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
    if (peer.role === "desktop") {
      // A replaced or departed desktop socket no longer owns the room.
      if (room.desktop.socket !== socket) return;
      this.scheduleOfflinePush(peer.roomId, socket);
      const timer = setTimeout(() => {
        this.desktopDisconnectTimers.delete(peer.roomId);
        if (this.rooms.get(peer.roomId)?.desktop.socket === socket) this.closeRoom(peer.roomId);
      }, this.desktopReconnectGraceMs);
      timer.unref?.();
      this.desktopDisconnectTimers.set(peer.roomId, timer);
      return;
    }
    room.mobiles.delete(peer.id);
    this.broadcastPresence(room);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /** Tells phones the desktop is gone and drops the room immediately. */
  private closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.rooms.delete(roomId);
    // A pending offline push (crash, sleep) must still fire after the grace.
    clearTimeout(this.desktopDisconnectTimers.get(roomId));
    this.desktopDisconnectTimers.delete(roomId);
    for (const mobile of room.mobiles.values()) {
      send(mobile.socket, { type: "presence", desktopOnline: false, mobileClients: 0 });
      mobile.socket.close(1012, "desktop offline");
    }
  }

  private clearDesktopTimers(roomId: string): void {
    clearTimeout(this.desktopDisconnectTimers.get(roomId));
    this.desktopDisconnectTimers.delete(roomId);
    clearTimeout(this.desktopOfflineTimers.get(roomId));
    this.desktopOfflineTimers.delete(roomId);
  }

  /** Handles plaintext relay control messages. Returns true when consumed. */
  private control(peer: Peer, raw: Record<string, unknown>): boolean {
    const room = this.rooms.get(peer.roomId);
    switch (raw.type) {
      case "push": {
        if (peer.role !== "desktop" || room?.desktop !== peer || !this.push) return true;
        const notification = parsePush(raw);
        if (!notification) return true;
        // A phone that is open and visible already shows the in-app banner.
        const skip = (deviceId: string) => [...room.mobiles.values()].some((mobile) =>
          mobile.deviceId === deviceId && mobile.foreground && mobile.socket.readyState === mobile.socket.OPEN);
        void this.push.deliver(peer.roomId, notification, skip).catch(() => {});
        return true;
      }
      case "desktop_goodbye":
        // An intentional shutdown will not reconnect: skip the grace period and
        // the offline push so a fresh desktop can claim the room at once.
        if (peer.role === "desktop" && room?.desktop === peer) this.closeRoom(peer.roomId);
        return true;
      case "push_register": {
        if (peer.role !== "mobile") return true;
        const registration = parseRegistration(raw, peer.deviceId);
        const enabled = Boolean(registration && this.push?.enabled(registration.platform));
        if (registration && enabled) this.push!.registry.upsert(peer.roomId, registration);
        send(peer.socket, { type: "push_registered", platform: raw.platform, enabled });
        return true;
      }
      case "push_unregister":
        if (peer.role === "mobile") this.push?.registry.remove(peer.roomId, peer.deviceId);
        return true;
      case "app_state":
        if (peer.role === "mobile" && typeof raw.foreground === "boolean") peer.foreground = raw.foreground;
        return true;
      default:
        return false;
    }
  }

  private scheduleOfflinePush(roomId: string, socket: WebSocket): void {
    if (!this.push || !this.push.registry.list(roomId).length) return;
    clearTimeout(this.desktopOfflineTimers.get(roomId));
    const timer = setTimeout(() => {
      this.desktopOfflineTimers.delete(roomId);
      const current = this.rooms.get(roomId);
      if (current && current.desktop.socket !== socket && current.desktop.socket.readyState === current.desktop.socket.OPEN) return;
      void this.push?.deliver(roomId, { kind: "desktop_offline", collapseId: "0" }, () => false).catch(() => {});
    }, this.desktopOfflinePushMs);
    timer.unref?.();
    this.desktopOfflineTimers.set(roomId, timer);
  }

  private async objectTicket(peer: Peer, raw: Record<string, unknown>): Promise<void> {
    const requestId = raw.requestId;
    const bytes = raw.bytes;
    if (typeof requestId !== "string" || requestId.length > 80) return;
    const room = this.rooms.get(peer.roomId);
    if (peer.role !== "desktop" || room?.desktop !== peer || !this.blobs?.enabledFor(peer.roomId) || !Number.isSafeInteger(bytes) || (bytes as number) < 16 || (bytes as number) > MAX_BLOB_BYTES || !peer.objectBytes.reserve(bytes as number)) {
      send(peer.socket, { type: "blob_ticket", requestId, error: "Object transfer unavailable" });
      return;
    }
    try {
      const ticket = await this.blobs.ticket(peer.roomId, bytes as number);
      if (this.rooms.get(peer.roomId)?.desktop === peer) send(peer.socket, { type: "blob_ticket", requestId, ticket });
    } catch {
      send(peer.socket, { type: "blob_ticket", requestId, error: "Object transfer unavailable" });
    }
  }

  private broadcastPresence(room: Room): void {
    const message = {
      type: "presence",
      desktopOnline: true,
      desktopConnectionId: room.desktop.connectionId,
      mobileClients: room.mobiles.size,
      mobileIds: [...room.mobiles.keys()],
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
  if (
    typeof raw.deviceName !== "string" ||
    raw.deviceName.trim().length === 0 ||
    Array.from(raw.deviceName).length > 80
  ) return null;
  return raw as unknown as HelloMessage;
}

function parseFrame(raw: unknown): FrameMessage | "too_large" | null {
  if (!isObject(raw) || raw.type !== "frame") return null;
  if (typeof raw.target !== "string" || raw.target.length > 80) return null;
  if (typeof raw.nonce !== "string" || raw.nonce.length !== 16) return null;
  if (typeof raw.ciphertext !== "string" || raw.ciphertext.length < 22) return null;
  if (raw.ciphertext.length > MAX_CIPHERTEXT_CHARS) return "too_large";
  return raw as unknown as FrameMessage;
}

function createPeer(socket: WebSocket, role: Peer["role"], roomId: string, id: string, deviceId: string): Peer {
  const messages = new TokenBucket(role === "desktop" ? DESKTOP_RATE : MOBILE_RATE);
  return { id, connectionId: randomUUID(), role, roomId, deviceId, foreground: true, socket, messages, objectBytes: new ObjectByteBudget(), drops: new DropCounter() };
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ready(clientId: string, desktopOnline: boolean, mobileClients: number) {
  return { type: "ready", clientId, desktopOnline, mobileClients };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
