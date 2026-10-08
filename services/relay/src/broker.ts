import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type WebSocket from "ws";
import { MAX_BLOB_BYTES, type TicketIssuer } from "./blobStore.js";
import { send, sendRaw } from "./outbound.js";
import { parsePush, parseRegistration, type PushService } from "./push.js";
import { DESKTOP_RATE, DropCounter, MOBILE_RATE, ObjectByteBudget, TokenBucket } from "./rateLimit.js";

const MAX_MOBILES_PER_ROOM = 8;
export const MAX_CIPHERTEXT_CHARS = 2 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = MAX_CIPHERTEXT_CHARS + 16 * 1024;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
/** Live-socket takeovers of one device id within this window mean two hosts share the id. */
const TAKEOVER_WINDOW_MS = 60_000;
const TAKEOVER_LIMIT = 3;

export interface HelloMessage {
  type: "hello";
  protocol: number;
  role: "desktop" | "mobile";
  roomId: string;
  authToken: string;
  deviceId: string;
  deviceName: string;
  targetDeviceId?: string;
}
interface Peer {
  id: string;
  connectionId: string;
  role: "desktop" | "mobile";
  roomId: string;
  deviceId: string;
  targetDeviceId?: string;
  foreground: boolean;
  socket: WebSocket;
  messages: TokenBucket;
  objectBytes: ObjectByteBudget;
  drops: DropCounter;
}
interface Device {
  deviceId: string;
  deviceName: string;
  desktop?: Peer;
  mobiles: Map<string, Peer>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  offlineTimer?: ReturnType<typeof setTimeout>;
  /** Times a still-open desktop socket was replaced by a new connection. */
  takeovers: number[];
}
interface Room {
  authToken: string;
  devices: Map<string, Device>;
  mobiles: Map<string, Peer>;
}

export class RelayBroker {
  private readonly rooms = new Map<string, Room>();
  private readonly peers = new WeakMap<WebSocket, Peer>();
  constructor(
    private readonly blobs?: TicketIssuer,
    private readonly desktopReconnectGraceMs = 15_000,
    private readonly push?: PushService,
    private readonly desktopOfflinePushMs = 5 * 60_000,
  ) {}

  close(): void {
    for (const room of this.rooms.values()) {
      for (const device of room.devices.values()) this.clearTimers(device);
    }
    this.push?.close();
  }

  register(socket: WebSocket, raw: unknown): boolean {
    if (this.peers.has(socket)) return this.reject(socket, "invalid_hello", "连接已完成握手");
    const hello = parseHello(raw);
    if (!hello) return this.reject(socket, "invalid_hello", "连接信息无效");
    const existing = this.rooms.get(hello.roomId);
    if (existing && !sameToken(existing.authToken, hello.authToken)) {
      return this.reject(socket, "unauthorized", "认证失败");
    }
    const room = existing ?? { authToken: hello.authToken, devices: new Map<string, Device>(), mobiles: new Map<string, Peer>() };
    if (hello.role === "desktop") {
      const device = room.devices.get(hello.deviceId) ?? {
        deviceId: hello.deviceId, deviceName: hello.deviceName, mobiles: new Map<string, Peer>(), takeovers: [],
      };
      const previous = device.desktop;
      if (previous && previous.socket.readyState === previous.socket.OPEN) {
        const now = Date.now();
        device.takeovers = device.takeovers.filter((at) => now - at < TAKEOVER_WINDOW_MS);
        if (device.takeovers.length >= TAKEOVER_LIMIT) {
          log("reject duplicate_device", hello.roomId, hello.deviceId);
          return this.reject(socket, "duplicate_device", "另一台电脑正在使用相同的设备 ID，本机需要生成新的设备 ID");
        }
        device.takeovers.push(now);
        log("desktop takeover", hello.roomId, hello.deviceId);
      }
      this.clearTimers(device);
      const peer = createPeer(socket, hello, hello.deviceId, hello.deviceId);
      device.desktop = peer;
      device.deviceName = hello.deviceName;
      room.devices.set(device.deviceId, device);
      this.rooms.set(hello.roomId, room);
      this.peers.set(socket, peer);
      // Replace ownership before closing: every path checks socket identity.
      if (previous) {
        this.peers.delete(previous.socket);
        previous.socket.close(4001, "desktop reconnected");
      }
      send(socket, { ...this.ready(peer, device), blobStorage: this.blobs?.enabledFor(peer.roomId) ?? false });
      this.broadcastPresence(device);
      this.broadcastDevices(room);
      return true;
    }
    let targetDeviceId = hello.targetDeviceId;
    if (hello.protocol === 1) {
      // Old apps cannot choose: bind to the only online desktop, ignoring stale offline entries.
      const live = [...room.devices.values()].filter(online);
      if (live.length > 1) return this.reject(socket, "device_selection_required", "多台电脑在线，请升级移动端并选择桌面设备");
      targetDeviceId = live[0]?.deviceId ?? (room.devices.size === 1 ? room.devices.keys().next().value : undefined);
      if (!targetDeviceId) return this.reject(socket, "desktop_offline", "桌面端尚未在线");
    }
    const device = targetDeviceId ? room.devices.get(targetDeviceId) : undefined;
    if (targetDeviceId && !device) return this.reject(socket, "invalid_target", "所选桌面设备不存在");
    if ((device?.mobiles.size ?? [...room.mobiles.values()].filter((p) => !p.targetDeviceId).length) >= MAX_MOBILES_PER_ROOM) {
      return this.reject(socket, "room_full", "已达到移动设备上限");
    }
    const peer = createPeer(socket, hello, `mobile-${randomUUID()}`, targetDeviceId);
    room.mobiles.set(peer.id, peer);
    device?.mobiles.set(peer.id, peer);
    this.rooms.set(hello.roomId, room);
    this.peers.set(socket, peer);
    if (device) {
      this.restoreLegacyPush(peer, device);
      send(socket, this.ready(peer, device));
    }
    if (hello.protocol === 2) this.sendDevices(socket, room);
    if (device) this.broadcastPresence(device);
    return true;
  }

  route(socket: WebSocket, raw: unknown): void {
    const peer = this.peers.get(socket);
    if (!peer) return;
    const room = this.rooms.get(peer.roomId);
    const device = peer.targetDeviceId ? room?.devices.get(peer.targetDeviceId) : undefined;
    if (!room || (peer.role === "desktop" && device?.desktop !== peer)) return;
    if (!peer.messages.take()) {
      if (peer.role === "desktop") peer.drops.record(`desktop room ${peer.roomId.slice(0, 8)}`);
      else this.reject(socket, "rate_limited", "消息过于频繁");
      return;
    }
    if (!device) {
      this.reject(socket, "device_selection_required", "请先选择桌面设备");
      return;
    }
    if (isObject(raw) && raw.type === "blob_ticket") {
      void this.objectTicket(peer, device, raw);
      return;
    }
    if (isObject(raw) && this.control(peer, room, device, raw)) return;
    const frame = parseFrame(raw);
    if (frame === "too_large") {
      this.reject(socket, "frame_too_large", `加密消息超过 ${MAX_CIPHERTEXT_CHARS} 字符上限`);
      return;
    }
    if (!frame) {
      this.reject(socket, "invalid_frame", "加密消息格式无效");
      return;
    }
    const forwarded = JSON.stringify({ ...frame, source: peer.id });
    if (peer.role === "mobile") {
      if (frame.target !== "desktop") {
        this.reject(socket, "invalid_target", "移动端只能向桌面端发送请求");
        return;
      }
      if (device.desktop && online(device)) sendRaw(device.desktop.socket, forwarded);
      return;
    }
    if (frame.target === "mobiles") {
      for (const mobile of device.mobiles.values()) sendRaw(mobile.socket, forwarded);
    } else {
      const target = device.mobiles.get(frame.target as string);
      if (target) sendRaw(target.socket, forwarded);
    }
  }

  disconnect(socket: WebSocket): void {
    const peer = this.peers.get(socket);
    if (!peer) return;
    this.peers.delete(socket);
    const room = this.rooms.get(peer.roomId);
    if (!room) return;
    const device = peer.targetDeviceId ? room.devices.get(peer.targetDeviceId) : undefined;
    if (peer.role === "mobile") {
      room.mobiles.delete(peer.id);
      device?.mobiles.delete(peer.id);
      if (device) this.broadcastPresence(device);
      return;
    }
    if (device?.desktop !== peer) return;
    device.desktop = undefined;
    this.broadcastDevices(room);
    this.scheduleOfflinePush(peer.roomId, device);
    device.disconnectTimer = setTimeout(() => {
      device.disconnectTimer = undefined;
      if (!device.desktop) this.closeDevice(room, device);
    }, this.desktopReconnectGraceMs);
    device.disconnectTimer.unref?.();
  }

  roomCount(): number { return this.rooms.size; }

  private closeDevice(room: Room, device: Device): void {
    clearTimeout(device.disconnectTimer);
    device.disconnectTimer = undefined;
    device.desktop = undefined;
    for (const mobile of device.mobiles.values()) {
      send(mobile.socket, { type: "presence", desktopOnline: false, mobileClients: 0, desktopDeviceId: device.deviceId, deviceName: device.deviceName });
      this.peers.delete(mobile.socket);
      room.mobiles.delete(mobile.id);
      mobile.socket.close(1012, "desktop offline");
    }
    device.mobiles.clear();
    // A pending offline push keeps the entry until it fires; otherwise forget the device now.
    if (!device.offlineTimer) this.pruneDevice(room, device);
    this.broadcastDevices(room);
  }

  /** Drops an offline device so stale hosts do not pile up in the device list forever. */
  private pruneDevice(room: Room, device: Device): void {
    if (device.desktop || device.mobiles.size || room.devices.get(device.deviceId) !== device) return;
    room.devices.delete(device.deviceId);
    for (const [roomId, candidate] of this.rooms) {
      if (candidate === room && !room.devices.size && !room.mobiles.size) this.rooms.delete(roomId);
    }
  }

  private clearTimers(device: Device): void {
    clearTimeout(device.disconnectTimer);
    clearTimeout(device.offlineTimer);
    device.disconnectTimer = undefined;
    device.offlineTimer = undefined;
  }

  private control(peer: Peer, room: Room, device: Device, raw: Record<string, unknown>): boolean {
    const scope = `${peer.roomId}:${device.deviceId}`;
    switch (raw.type) {
      case "push": {
        if (peer.role !== "desktop" || !this.push) return true;
        const notification = parsePush({ ...raw, desktopDeviceId: device.deviceId });
        if (!notification) return true;
        const skip = (deviceId: string) => [...device.mobiles.values()].some((mobile) =>
          mobile.deviceId === deviceId && mobile.foreground && mobile.socket.readyState === mobile.socket.OPEN);
        void this.push.deliver(scope, notification, skip).catch(() => {});
        return true;
      }
      case "desktop_goodbye":
        if (peer.role === "desktop") {
          this.peers.delete(peer.socket);
          this.clearTimers(device);
          this.closeDevice(room, device);
          peer.socket.close(1000, "desktop goodbye");
        }
        return true;
      case "push_register": {
        if (peer.role !== "mobile") return true;
        if (raw.targetDeviceId !== undefined && raw.targetDeviceId !== device.deviceId) {
          this.reject(peer.socket, "invalid_target", "推送目标与当前绑定设备不一致");
          return true;
        }
        const registration = parseRegistration(raw, peer.deviceId);
        const enabled = Boolean(registration && this.push?.enabled(registration.platform));
        if (registration && enabled) this.push!.registry.upsert(scope, registration);
        send(peer.socket, { type: "push_registered", platform: raw.platform, enabled, targetDeviceId: device.deviceId });
        return true;
      }
      case "push_unregister":
        if (peer.role === "mobile") this.push?.registry.remove(scope, peer.deviceId);
        return true;
      case "app_state":
        if (peer.role === "mobile" && typeof raw.foreground === "boolean") peer.foreground = raw.foreground;
        return true;
      default: return false;
    }
  }

  /** Legacy registrations have no desktop identity. Only a bound phone can claim its own entry. */
  private restoreLegacyPush(peer: Peer, device: Device): void {
    const registry = this.push?.registry;
    if (!registry) return;
    const legacy = registry.list(peer.roomId).find((entry) => entry.deviceId === peer.deviceId);
    if (!legacy) return;
    const scope = `${peer.roomId}:${device.deviceId}`;
    // A newer scoped registration wins over the old persisted token/settings.
    if (!registry.list(scope).some((entry) => entry.deviceId === peer.deviceId || entry.token === legacy.token)) {
      registry.upsert(scope, legacy);
    }
    registry.remove(peer.roomId, peer.deviceId, legacy.token);
  }

  private scheduleOfflinePush(roomId: string, device: Device): void {
    const scope = `${roomId}:${device.deviceId}`;
    if (!this.push || !this.push.registry.list(scope).length) return;
    clearTimeout(device.offlineTimer);
    device.offlineTimer = setTimeout(() => {
      device.offlineTimer = undefined;
      if (device.desktop) return;
      const room = this.rooms.get(roomId);
      if (room && !device.disconnectTimer) {
        this.pruneDevice(room, device);
        this.broadcastDevices(room);
      }
      void this.push?.deliver(scope, { kind: "desktop_offline", desktopDeviceId: device.deviceId,
        collapseId: createHash("sha256").update(`desktop_offline:${scope}`).digest("hex") }, () => false).catch(() => {});
    }, this.desktopOfflinePushMs);
    device.offlineTimer.unref?.();
  }

  private async objectTicket(peer: Peer, device: Device, raw: Record<string, unknown>): Promise<void> {
    const { requestId, bytes } = raw;
    if (typeof requestId !== "string" || requestId.length > 80) return;
    if (peer.role !== "desktop" || device.desktop !== peer || !this.blobs?.enabledFor(peer.roomId) || !Number.isSafeInteger(bytes) || (bytes as number) < 16 || (bytes as number) > MAX_BLOB_BYTES || !peer.objectBytes.reserve(bytes as number)) {
      send(peer.socket, { type: "blob_ticket", requestId, error: "Object transfer unavailable" });
      return;
    }
    try {
      const ticket = await this.blobs.ticket(peer.roomId, bytes as number, device.deviceId);
      if (device.desktop === peer) send(peer.socket, { type: "blob_ticket", requestId, ticket });
    } catch {
      if (device.desktop === peer) send(peer.socket, { type: "blob_ticket", requestId, error: "Object transfer unavailable" });
    }
  }

  private ready(peer: Peer, device: Device) {
    return { type: "ready", clientId: peer.id, desktopOnline: online(device), mobileClients: device.mobiles.size,
      desktopConnectionId: device.desktop?.connectionId, desktopDeviceId: device.deviceId, deviceName: device.deviceName };
  }

  private broadcastPresence(device: Device): void {
    const message = { type: "presence", desktopOnline: online(device), desktopConnectionId: device.desktop?.connectionId,
      desktopDeviceId: device.deviceId, deviceName: device.deviceName,
      mobileClients: device.mobiles.size, mobileIds: [...device.mobiles.keys()] };
    if (device.desktop) send(device.desktop.socket, message);
    for (const mobile of device.mobiles.values()) send(mobile.socket, message);
  }

  private sendDevices(socket: WebSocket, room: Room): void {
    send(socket, { type: "devices", devices: [...room.devices.values()].map((device) => ({
      deviceId: device.deviceId, deviceName: device.deviceName, online: online(device),
    })) });
  }

  private broadcastDevices(room: Room): void {
    for (const mobile of room.mobiles.values()) this.sendDevices(mobile.socket, room);
  }

  private reject(socket: WebSocket, code: string, message: string): false {
    send(socket, { type: "error", code, message });
    socket.close(4000, code);
    return false;
  }
}

function online(device: Device): boolean {
  return Boolean(device.desktop && device.desktop.socket.readyState === device.desktop.socket.OPEN);
}
function parseHello(raw: unknown): HelloMessage | null {
  if (!isObject(raw) || raw.type !== "hello" || (raw.protocol !== 1 && raw.protocol !== 2)) return null;
  if (raw.role !== "desktop" && raw.role !== "mobile") return null;
  if (typeof raw.roomId !== "string" || !HASH_PATTERN.test(raw.roomId)) return null;
  if (typeof raw.authToken !== "string" || !HASH_PATTERN.test(raw.authToken)) return null;
  if (typeof raw.deviceId !== "string" || !DEVICE_PATTERN.test(raw.deviceId)) return null;
  if (typeof raw.deviceName !== "string" || !raw.deviceName.trim() || Array.from(raw.deviceName).length > 80) return null;
  if (raw.targetDeviceId !== undefined && (typeof raw.targetDeviceId !== "string" || !DEVICE_PATTERN.test(raw.targetDeviceId))) return null;
  return raw as unknown as HelloMessage;
}
function parseFrame(raw: unknown): Record<string, unknown> | "too_large" | null {
  if (!isObject(raw) || raw.type !== "frame") return null;
  if (typeof raw.target !== "string" || raw.target.length > 80) return null;
  if (typeof raw.nonce !== "string" || raw.nonce.length !== 16) return null;
  if (typeof raw.ciphertext !== "string" || raw.ciphertext.length < 22) return null;
  if (raw.ciphertext.length > MAX_CIPHERTEXT_CHARS) return "too_large";
  return { type: "frame", target: raw.target, nonce: raw.nonce, ciphertext: raw.ciphertext };
}
function createPeer(socket: WebSocket, hello: HelloMessage, id: string, targetDeviceId?: string): Peer {
  return { id, connectionId: randomUUID(), role: hello.role, roomId: hello.roomId, deviceId: hello.deviceId,
    targetDeviceId, foreground: true, socket, messages: new TokenBucket(hello.role === "desktop" ? DESKTOP_RATE : MOBILE_RATE),
    objectBytes: new ObjectByteBudget(), drops: new DropCounter() };
}
function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function log(event: string, roomId: string, deviceId: string): void {
  console.info(`[relay] ${event} room=${roomId.slice(0, 8)} device=${deviceId.slice(0, 16)}`);
}
