// JSON-RPC over WebSocket client for the miniQ daemon.

import type { DaemonEvent } from "./types";
import { isTauriRuntime } from "./runtime";
import { decryptRemotePayload, deriveRemoteIdentity, encryptRemotePayload } from "./remoteCrypto";
import { loadRemoteCredentials, type RemoteCredentials } from "./remoteAccess";

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
  private connectionMode: "local" | "remote" = "local";
  private remoteKey: CryptoKey | null = null;

  /** Idempotent: concurrent calls share one in-flight connection attempt, so
   * React StrictMode's double-mounted effects cannot open two sockets — and
   * the second caller genuinely waits until the socket is open instead of
   * returning early and firing calls against a null socket. */
  async connect(info: ConnectionInfo): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.ws) {
      const staleSocket = this.ws;
      this.ws = null;
      this.remoteKey = null;
      staleSocket.close(4000, "stale connection");
      this.notifyStatus(false);
    }
    if (this.connectPromise) return this.connectPromise;
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
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      let remoteMessageQueue: Promise<void> = Promise.resolve();
      let settled = false;
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
      };
      ws.onclose = () => {
        window.clearTimeout(connectTimer);
        fail(new Error(this.connectionMode === "remote" ? "桌面端未在线或远程连接已关闭" : "daemon 连接已关闭"));
        if (this.ws === ws) {
          this.ws = null;
          this.remoteKey = null;
          this.notifyStatus(false);
          for (const p of this.pending.values()) {
            window.clearTimeout(p.timer);
            p.reject(new Error("connection closed"));
          }
          this.pending.clear();
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
              if (envelope.desktopOnline !== true) throw new Error("桌面端尚未在线");
              this.remoteKey = remoteKey;
              this.ws = ws;
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
            if (envelope.type !== "frame") return;
            const payload = await decryptRemotePayload<Record<string, unknown>>(
              remoteKey,
              String(envelope.nonce ?? ""),
              String(envelope.ciphertext ?? ""),
            );
            if (this.ws !== ws) return;
            this.onMessage(JSON.stringify(payload));
          })
          .catch((error) => {
            fail(error instanceof Error ? error : new Error(String(error)));
            ws.close(4000, "invalid remote message");
          });
      };
    });
    return this.connectPromise;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get mode(): "local" | "remote" {
    return this.connectionMode;
  }

  private onMessage(raw: string) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof data.type === "string") {
      for (const listener of this.eventListeners) {
        listener(data as unknown as DaemonEvent);
      }
      return;
    }
    const id = String(data.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    window.clearTimeout(pending.timer);
    if (data.error) {
      const err = data.error as RpcError;
      pending.reject(new Error(`${err.message} (code ${err.code})`));
    } else {
      pending.resolve(data.result);
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("not connected"));
    const id = `req_${this.nextId++}`;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`请求 ${method} 超时`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (this.connectionMode === "local") {
        try {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("daemon 连接已关闭");
          ws.send(payload);
        } catch (error) {
          this.pending.delete(id);
          window.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      const key = this.remoteKey;
      if (!key) {
        this.pending.delete(id);
        window.clearTimeout(timer);
        reject(new Error("远程加密通道尚未就绪"));
        return;
      }
      void encryptRemotePayload(key, JSON.parse(payload))
        .then((encrypted) => {
          if (!this.pending.has(id)) return;
          if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) throw new Error("远程连接已关闭");
          ws.send(JSON.stringify({ type: "frame", target: "desktop", ...encrypted }));
        })
        .catch((error) => {
          this.pending.delete(id);
          window.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  onEvent(listener: (event: DaemonEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notifyStatus(connected: boolean) {
    for (const listener of this.statusListeners) {
      listener(connected);
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
