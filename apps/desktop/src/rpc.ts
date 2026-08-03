// JSON-RPC over WebSocket client for the miniQ daemon.

import type { DaemonEvent } from "./types";
import { isTauriRuntime } from "./runtime";

export interface ConnectionInfo {
  port: number;
  token: string;
}

interface RpcError {
  code: number;
  message: string;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class RpcClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private eventListeners = new Set<(event: DaemonEvent) => void>();
  private statusListeners = new Set<(connected: boolean) => void>();

  /** Idempotent: concurrent calls share one in-flight connection attempt, so
   * React StrictMode's double-mounted effects cannot open two sockets — and
   * the second caller genuinely waits until the socket is open instead of
   * returning early and firing calls against a null socket. */
  async connect(info: ConnectionInfo): Promise<void> {
    if (this.ws) return;
    if (this.connectPromise) return this.connectPromise;
    const url = `ws://127.0.0.1:${info.port}/ws?token=${encodeURIComponent(info.token)}`;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        this.ws = ws;
        this.notifyStatus(true);
        resolve();
      };
      ws.onerror = () => reject(new Error("failed to connect to daemon"));
      ws.onclose = () => {
        this.ws = null;
        this.notifyStatus(false);
        for (const p of this.pending.values()) {
          p.reject(new Error("connection closed"));
        }
        this.pending.clear();
      };
      ws.onmessage = (msg) => this.onMessage(String(msg.data));
    });
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null;
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(payload);
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
    return await invoke<ConnectionInfo>("daemon_connection");
  }
  const params = new URLSearchParams(window.location.search);
  const port = Number(params.get("port"));
  const token = params.get("token") ?? "";
  if (!port || !token) {
    throw new Error(
      "no daemon connection: open through the desktop app, or pass ?port=&token= in dev",
    );
  }
  return { port, token };
}
