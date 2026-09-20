import { RpcClient, type HostEvent } from "../rpc";
import type { SavedHost } from "../hostWorkspace";

/** Synthetic, in-memory root transport for preview and isolation tests only. */
export class SshFixtureRoot extends RpcClient {
  mobile = false;
  hosts: SavedHost[] = [
    { hostId: "demo-development", label: "开发服务器", state: "connected", version: "0.1.41" },
    { hostId: "demo-research", label: "研究服务器", state: "connected", version: "0.1.41" },
    { hostId: "demo-offline", label: "离线服务器", state: "disconnected" },
  ];
  events = new Set<(event: HostEvent) => void>();
  override get mode(): "remote" | "local" { return this.mobile ? "remote" : "local"; }
  override get connected() { return true; }
  override async connect() {}
  override disconnect() {}
  override onHostEvent(listener: (event: HostEvent) => void) { this.events.add(listener); return () => { this.events.delete(listener); }; }
  emit(event: HostEvent) { this.events.forEach((listener) => listener(event)); }
  override async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const p = (params ?? {}) as { hostId?: string; method?: string; params?: unknown; sessionId?: string };
    let result: unknown = {};
    if (method === "host.list") result = { hosts: this.hosts.map((host) => ({ ...host })), discovered: [{ alias: "demo-staging", hostName: "staging.example.test" }] };
    else if (method === "host.save") {
      if (!this.hosts.some((host) => host.hostId === p.hostId)) this.hosts.push({ hostId: p.hostId!, label: p.hostId!, state: "disconnected" });
    } else if (method === "host.remove") this.hosts = this.hosts.filter((host) => host.hostId !== p.hostId);
    else if (method === "host.connect" || method === "host.disconnect") {
      if (method === "host.connect" && p.hostId?.includes("offline")) throw new Error("演示主机暂不可达；本机及其他电脑保持连接");
      const host = this.hosts.find((entry) => entry.hostId === p.hostId);
      if (host) host.state = method === "host.connect" ? "connected" : "disconnected";
      this.emit({ type: "host_changed", hostId: p.hostId! });
    } else if (method === "host.call") return this.content<T>(p.hostId!, p.method!, p.params);
    else return this.content<T>(null, method, params);
    return result as T;
  }
  async content<T>(host: string | null, method: string, _params?: unknown): Promise<T> {
    const label = host === null ? "本地产品" : host === "demo-development" ? "开发项目" : "研究项目";
    const workspace = { id: "same-workspace", path: "/demo/project", name: label, additionalPaths: [], createdAt: "2026-09-20T08:00:00Z", updatedAt: "2026-09-20T08:00:00Z" };
    const session = { id: "same-session", workspaceId: workspace.id, workingDirectory: workspace.path, title: `${label} · 任务进度`, status: "idle", pinned: false, archived: false, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt };
    const data: Record<string, unknown> = {
      "workspace.list": { workspaces: [workspace] }, "session.list": { sessions: [session] },
      "settings.get": { approvalMode: "auto", provider: { hasApiKey: true, model: "demo-model", apiProtocol: "auto" } },
      "daemon.health": { status: "ok", version: "0.1.41" },
    };
    return (data[method] ?? {}) as T;
  }
}
