import type { Session, Workspace } from "./types";

export type HostState = "connected" | "connecting" | "disconnected" | "error";
export interface SavedHost {
  hostId: string;
  label: string;
  state: HostState;
  version?: string;
  error?: string;
}
export interface DiscoveredHost { alias: string; hostName?: string; user?: string; port?: number }
export interface HostList { hosts: SavedHost[]; discovered: DiscoveredHost[] }
export interface HostCatalog {
  hostId: string | null;
  label: string;
  state: HostState;
  error?: string;
  workspaces: Workspace[];
  sessions: Session[];
  unreadSessionIds: ReadonlySet<string>;
}
export interface HostNavigation { workspaceId: string | null; sessionId: string | null }
export type HostDestination = HostNavigation & { action?: "edit" | "create"; revision: number };

export const hostKey = (host: string | null) => JSON.stringify(host);
export const scopedKey = (host: string | null, id: string) => JSON.stringify([host, id]);
export const emptyCatalog = (hostId: string | null, label: string): HostCatalog => ({
  hostId, label, state: "disconnected", workspaces: [], sessions: [], unreadSessionIds: new Set(),
});

export function validSshTarget(value: string): boolean {
  const parts = value.split("@");
  if (parts.length > 2 || (parts.length === 2 && !/^[\w.][\w.-]*$/.test(parts[0]))) return false;
  const supplied = parts.at(-1)!;
  const host = supplied.startsWith("[") && supplied.endsWith("]") ? supplied.slice(1, -1) : supplied;
  if (supplied === host && /^[\w.][\w.-]*$/.test(host)) return true;
  if (!/^[\da-fA-F:.]+$/.test(host) || !host.includes(":")) return false;
  try { return new URL(`http://[${host}]/`).hostname.startsWith("["); } catch { return false; }
}
