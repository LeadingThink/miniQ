import { RpcClient, type ConnectionInfo } from "./rpc";
import type { DaemonEvent } from "./types";

/** An execution target on the existing root transport. In particular, a phone
 * never opens a plaintext socket to an SSH proxy or receives its credentials. */
export class HostRpcClient extends RpcClient {
  private available = true;
  private listeners = new Set<(connected: boolean) => void>();
  private connecting: Promise<void> | null = null;

  constructor(private readonly root: RpcClient, readonly hostId: string) {
    super();
  }

  override get mode(): "remote" { return "remote"; }
  override get sshHost() { return this.hostId; }
  override get connected() { return this.root.connected && this.available; }

  setAvailable(available: boolean) {
    if (available === this.available) return;
    this.available = available;
    for (const listener of this.listeners) listener(this.connected);
  }

  override async connect(info: ConnectionInfo) {
    if (this.connecting) return this.connecting;
    const attempt = (async () => {
      if (!this.root.connected) await this.root.connect(info);
      await this.root.call("host.connect", { hostId: this.hostId });
      this.setAvailable(true);
    })();
    this.connecting = attempt;
    try { await attempt; } finally { if (this.connecting === attempt) this.connecting = null; }
  }

  // Detaching a view must not disconnect another view, the relay, or the task.
  override disconnect() {}

  override call<T = unknown>(method: string, params?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    return this.root.call<T>("host.call", { hostId: this.hostId, method, params }, options);
  }

  override onEvent(listener: (event: DaemonEvent) => void) {
    return this.root.onHostEvent((event) => {
      if (event.type === "host_event" && event.hostId === this.hostId && event.event.type !== "remote_resync") listener(event.event);
    });
  }

  override onStatus(listener: (connected: boolean) => void) {
    this.listeners.add(listener);
    const stop = this.root.onStatus((connected) => listener(connected && this.available));
    return () => { stop(); this.listeners.delete(listener); };
  }

  override onResync(listener: () => void) {
    const offRoot = this.root.onResync(listener);
    const offHost = this.root.onHostEvent((event) => {
      if (event.type === "host_event" && event.hostId === this.hostId && event.event.type === "remote_resync") listener();
    });
    return () => { offRoot(); offHost(); };
  }

  override selectSession(sessionId: string | null) {
    this.root.selectSession(sessionId, this.hostId);
  }
}
