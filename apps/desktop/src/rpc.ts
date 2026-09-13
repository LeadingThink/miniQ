// JSON-RPC over WebSocket client for the miniQ daemon.

import type { DaemonEvent } from "./types";
import { isTauriRuntime } from "./runtime";
import { decryptRemotePayload, deriveRemoteIdentity, encryptRemotePayload } from "./remoteCrypto";
import { loadRemoteCredentials, type RemoteCredentials } from "./remoteAccess";
import { RemotePayloadReader } from "./remotePayload";
import { remoteUploadFrames } from "./remoteUpload";

export interface LocalConnectionInfo {
  kind: "local";
  port: number;
  token: string;
}

export interface RemoteConnectionInfo extends RemoteCredentials {
  kind: "remote";
}

export type ConnectionInfo = LocalConnectionInfo | RemoteConnectionInfo;

interface RpcError {
  code: number;
  message: string;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
  method: string;
  cleanup: () => void;
};

const CONNECTION_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 60_000;

export class RpcClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private eventListeners = new Set<(event: DaemonEvent) => void>();
  private statusListeners = new Set<(connected: boolean) => void>();
  private resyncListeners = new Set<() => void>();
  private connectionMode: "local" | "remote" = "local";
  private remoteKey: CryptoKey | null = null;
  private reader: RemotePayloadReader | null = null;
  private outgoing: Promise<void> = Promise.resolve();

  /** Idempotent: concurrent calls share one in-flight connection attempt, so
   * React StrictMode's double-mounted effects cannot open two sockets — and
   * the second caller genuinely waits until the socket is open instead of
   * returning early and firing calls against a null socket. */
  async connect(info: ConnectionInfo): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.ws) {
      const staleSocket = this.ws;
      this.ws = null;
      this.remoteKey = null;
      staleSocket.close(4000, "stale connection");
      this.notifyStatus(false);
    }
    this.connectionMode = info.kind;
    this.connectPromise = info.kind === "remote" ? this.connectRemote(info) : this.connectLocal(info);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private connectLocal(info: LocalConnectionInfo): Promise<void> {
    const url = `ws://127.0.0.1:${info.port}/ws?token=${encodeURIComponent(info.token)}`;
    return this.openSocket(url, (ws, resolve) => {
      this.ws = ws;
      this.notifyStatus(true);
      resolve();
    });
  }

  private async connectRemote(info: RemoteConnectionInfo): Promise<void> {
    const identity = await deriveRemoteIdentity(info.apiKey);
    return this.openSocket(info.relayUrl, (ws) => {
      ws.send(JSON.stringify({
        type: "hello",
        protocol: 1,
        role: "mobile",
        roomId: identity.roomId,
        authToken: identity.authToken,
        deviceId: info.deviceId,
        deviceName: info.deviceName,
      }));
    }, identity.encryptionKey);
  }

  private openSocket(
    url: string,
    onOpen: (socket: WebSocket, resolve: () => void) => void,
    remoteKey?: CryptoKey,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const reader = new RemotePayloadReader(remoteKey, (id) => this.pending.has(id));
      let remoteMessageQueue: Promise<void> = Promise.resolve();
      let settled = false;
      let desktopConnectionId = "";
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(connectTimer);
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(connectTimer);
        reject(error);
      };
      const connectTimer = window.setTimeout(() => {
        fail(new Error(this.connectionMode === "remote" ? "连接 miniQ relay 超时" : "连接 miniQ daemon 超时"));
        ws.close(4000, "connect timeout");
      }, CONNECTION_TIMEOUT_MS);
      ws.onopen = () => {
        if (settled) {
          ws.close(4000, "stale connection");
          return;
        }
        try {
          onOpen(ws, finish);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          ws.close(4000, "handshake failed");
        }
      };
      ws.onerror = () => {
        fail(new Error(this.connectionMode === "remote" ? "无法连接 miniQ relay" : "无法连接 miniQ daemon"));
        ws.close(4000, "transport error");
      };
      ws.onclose = () => {
        reader.dispose();
        window.clearTimeout(connectTimer);
        fail(new Error(this.connectionMode === "remote" ? "桌面端未在线或远程连接已关闭" : "daemon 连接已关闭"));
        if (this.ws === ws) {
          this.ws = null;
          this.remoteKey = null;
          for (const p of this.pending.values()) {
            window.clearTimeout(p.timer);
            p.cleanup();
            p.reject(new Error("connection closed"));
          }
          this.pending.clear();
          this.notifyStatus(false);
        }
      };
      ws.onmessage = (message) => {
        if (!remoteKey) {
          if (this.ws !== ws) return;
          this.onMessage(String(message.data));
          return;
        }
        remoteMessageQueue = remoteMessageQueue
          .then(async () => {
            if (settled && this.ws !== ws) return;
            const envelope = JSON.parse(String(message.data)) as Record<string, unknown>;
            if (envelope.type === "ready") {
              desktopConnectionId = String(envelope.desktopConnectionId ?? "");
              if (envelope.desktopOnline !== true) throw new Error("桌面端尚未在线");
              this.remoteKey = remoteKey;
              this.ws = ws;
              this.reader = reader;
              if (!settled) {
                this.notifyStatus(true);
                finish();
              }
              return;
            }
            if (envelope.type === "error") {
              throw new Error(String(envelope.message ?? "远程连接失败"));
            }
            if (envelope.type === "presence" && envelope.desktopOnline === false) {
              ws.close(1012, "desktop offline");
              return;
            }
            if (envelope.type === "presence" && typeof envelope.desktopConnectionId === "string" && envelope.desktopConnectionId !== desktopConnectionId) {
              desktopConnectionId = envelope.desktopConnectionId;
              this.onMessage(JSON.stringify({ type: "remote_resync" }));
              return;
            }
            if (envelope.type !== "frame") return;
            const payload = await decryptRemotePayload<Record<string, unknown>>(
              remoteKey,
              String(envelope.nonce ?? ""),
              String(envelope.ciphertext ?? ""),
            );
            if (this.ws !== ws) return;
            if (payload.type === "remote_blob") {
              const id = String(payload.requestId ?? "");
              this.refreshTimeout(id);
              // Object downloads must not hold the ordered WebSocket event queue.
              void reader.readAsync(payload).then((items) => {
                if (this.ws === ws) for (const item of items) this.onMessage(JSON.stringify(item));
              }).catch((error) => {
                if (this.ws !== ws) return;
                const pending = this.pending.get(id);
                if (!pending) return;
                this.pending.delete(id);
                window.clearTimeout(pending.timer);
                pending.cleanup();
                pending.reject(error instanceof Error ? error : new Error("远程下载失败，请重试"));
              });
              return;
            }
            const completed = await reader.readAsync(payload);
            if (payload.type === "remote_chunk" && payload.requestId != null) {
              this.refreshTimeout(String(payload.requestId));
            }
            for (const item of completed) this.onMessage(JSON.stringify(item));
          })
          .catch((error) => {
            fail(error instanceof Error ? error : new Error(String(error)));
            ws.close(4000, "invalid remote message");
          });
      };
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Drop the current socket so the next connect() re-derives identity from
   * freshly stored credentials (used when the user swaps their API key). */
  disconnect(reason = "disconnected") {
    const socket = this.ws;
    this.ws = null;
    this.remoteKey = null;
    if (socket) {
      socket.close(4000, reason);
      this.notifyStatus(false);
    }
  }

  get mode(): "local" | "remote" {
    return this.connectionMode;
  }

  selectSession(sessionId: string | null) {
    if (this.connectionMode === "remote" && this.ws && this.remoteKey) {
      void this.sendRemote(this.ws, this.remoteKey, { type: "remote_select", sessionId, acceptEncoding: "gzip" }).catch(() => {});
    }
  }

  private onMessage(raw: string) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof data.type === "string") {
      if (data.type === "remote_resync") {
        for (const listener of this.resyncListeners) this.deliver(listener);
        return;
      }
      for (const listener of this.eventListeners) {
        this.deliver(() => listener(data as unknown as DaemonEvent));
      }
      return;
    }
    const id = String(data.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    window.clearTimeout(pending.timer);
    pending.cleanup();
    if (data.error) {
      const err = data.error as RpcError;
      pending.reject(new Error(`${err.message} (code ${err.code})`));
    } else {
      pending.resolve(data.result);
    }
  }

  call<T = unknown>(method: string, params?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new DOMException("Request cancelled", "AbortError"));
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("not connected"));
    const id = `req_${this.nextId++}`;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        this.cancelRemoteRequest(id);
        if (method !== "daemon.health") this.disconnect("rpc timeout");
        reject(new Error(`请求 ${method} 超时`));
      }, options.timeoutMs ?? RPC_TIMEOUT_MS);
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        window.clearTimeout(pending.timer);
        pending.cleanup();
        this.cancelRemoteRequest(id);
        reject(new DOMException("Request cancelled", "AbortError"));
      };
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (this.connectionMode === "local") {
        try {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("daemon 连接已关闭");
          ws.send(payload);
        } catch (error) {
          this.pending.delete(id);
          window.clearTimeout(timer);
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      const key = this.remoteKey;
      if (!key) {
        this.pending.delete(id);
        window.clearTimeout(timer);
        cleanup();
        reject(new Error("远程加密通道尚未就绪"));
        return;
      }
      void this.sendRemote(ws, key, { ...JSON.parse(payload), acceptEncoding: "gzip", acceptBlob: true }, () => this.pending.has(id))
        .catch((error) => {
          this.pending.delete(id);
          window.clearTimeout(timer);
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private sendRemote(ws: WebSocket, key: CryptoKey, payload: unknown, current = () => true): Promise<void> {
    const sending = this.outgoing.then(async () => {
      if (!current()) return;
      for (const frame of remoteUploadFrames(payload)) {
        if (!current()) return;
        const encrypted = await encryptRemotePayload(key, frame);
        if (!current()) return;
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) throw new Error("远程连接已关闭");
        ws.send(JSON.stringify({ type: "frame", target: "desktop", ...encrypted }));
      }
    });
    this.outgoing = sending.catch(() => {});
    return sending;
  }

  onEvent(listener: (event: DaemonEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  private refreshTimeout(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pending.timer = window.setTimeout(() => {
      this.pending.delete(id);
      pending.cleanup();
      this.cancelRemoteRequest(id);
      pending.reject(new Error(`请求 ${pending.method} 超时`));
    }, RPC_TIMEOUT_MS);
  }

  private cancelRemoteRequest(id: string) {
    this.reader?.cancelRequest(id);
    if (this.connectionMode === "remote" && this.ws && this.remoteKey) {
      void this.sendRemote(this.ws, this.remoteKey, { type: "remote_cancel", requestId: id }).catch(() => {});
    }
  }

  private deliver(listener: () => void) {
    try { listener(); }
    catch (error) { console.error("miniQ event listener failed", error); }
  }

  private notifyStatus(connected: boolean) {
    for (const listener of this.statusListeners) {
      this.deliver(() => listener(connected));
    }
  }
}

/// Resolve daemon connection info.
/// - Inside Tauri: ask the shell (it spawns/discovers the daemon).
/// - In a plain browser (dev): read ?port=...&token=... from the URL.
export async function resolveConnection(): Promise<ConnectionInfo> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const local = await invoke<Omit<LocalConnectionInfo, "kind">>("daemon_connection");
    return { kind: "local", ...local };
  }
  const params = new URLSearchParams(window.location.search);
  const port = Number(params.get("port"));
  const token = params.get("token") ?? "";
  if (!port || !token) {
    const remote = await loadRemoteCredentials();
    if (remote) return { kind: "remote", ...remote };
    throw new Error("请先输入与桌面端相同的 API Key");
  }
  return { kind: "local", port, token };
}
