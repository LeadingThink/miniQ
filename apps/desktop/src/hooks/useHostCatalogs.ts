import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { HostRpcClient } from "../hostRpc";
import { emptyCatalog, hostKey, validSshTarget, type HostCatalog, type HostList, type HostNavigation } from "../hostWorkspace";
import type { DaemonEvent, Session, Workspace } from "../types";
import { useDaemonConnection } from "./useDaemonConnection";
import { isSessionRunning, isSessionTerminal } from "../sessionStatus";
import { errorMessage } from "../errorMessage";

const LEGACY_HOSTS = "miniq.ssh.saved-hosts";
const noop = async () => {};

export function useHostCatalogs(root: RpcClient, clientFor: (host: string | null) => RpcClient, active: { host: string | null; navigation: HostNavigation }, paused = false) {
  const [registry, setRegistry] = useState<HostList>({ hosts: [], discovered: [] });
  const [catalogs, setCatalogs] = useState<Record<string, HostCatalog>>({ [hostKey(null)]: emptyCatalog(null, "本机") });
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);
  const activeRef = useRef(active);
  activeRef.current = active;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const inflight = useRef(new Map<string, Promise<void>>());
  const queued = useRef(new Set<string>());
  const knownHosts = useRef<Set<string> | null>(null);
  const registryEpoch = useRef(0);
  const reportHostError = useCallback((host: string | null, cause: unknown) => {
    if (!alive.current) return;
    setCatalogs((current) => {
      const key = hostKey(host), catalog = current[key];
      return catalog ? { ...current, [key]: { ...catalog, error: errorMessage(cause) } } : current;
    });
  }, []);
  const refreshCatalog = useCallback((host: string | null, changedDuringRequest = false) => {
    const key = hostKey(host);
    const previous = inflight.current.get(key);
    if (previous) { if (changedDuringRequest) queued.current.add(key); return previous; }
    const pending = (async () => {
      do {
        queued.current.delete(key);
        const client = clientFor(host);
        const [workspaceResult, sessionResult] = await Promise.all([
          client.call<{ workspaces: Workspace[] }>("workspace.list"),
          client.call<{ sessions: Session[] }>("session.list", {}),
        ]);
        if (!alive.current) return;
        const workspaces = workspaceResult.workspaces.map((workspace) => ({ ...workspace, additionalPaths: workspace.additionalPaths ?? [] }));
        const sessions = sessionResult.sessions.map((session) => ({ ...session, workingDirectory: session.workingDirectory ?? workspaces.find((workspace) => workspace.id === session.workspaceId)?.path ?? "" }));
        setCatalogs((current) => {
          if (host && knownHosts.current && !knownHosts.current.has(host)) return current;
          const catalog = current[key] ?? emptyCatalog(host, host ?? "本机");
          return { ...current, [key]: { ...catalog,
            // A delayed catalog response cannot override a newer disconnect.
            state: host === null ? (root.connected ? "connected" : "disconnected") : catalog.state,
            error: host === null || catalog.state === "connected" ? undefined : catalog.error,
            workspaces, sessions,
          } };
        });
      } while (queued.current.has(key));
    })().finally(() => inflight.current.delete(key));
    inflight.current.set(key, pending);
    return pending;
  }, [root, clientFor]);
  const refreshHosts = useCallback(async () => {
    const generation = ++registryEpoch.current;
    const result = await root.call<HostList>("host.list");
    if (!alive.current || generation !== registryEpoch.current) return;
    knownHosts.current = new Set(result.hosts.map((host) => host.hostId));
    setRegistry(result);
    setCatalogs((current) => {
      const next: Record<string, HostCatalog> = { [hostKey(null)]: current[hostKey(null)] };
      for (const host of result.hosts) next[hostKey(host.hostId)] = { ...(current[hostKey(host.hostId)] ?? emptyCatalog(host.hostId, host.label)), ...host, error: host.error };
      return next;
    });
    for (const host of result.hosts) (clientFor(host.hostId) as HostRpcClient).setAvailable(host.state === "connected");
    // Registry readiness must not wait for the slowest execution host. Each
    // catalog settles independently; navigation waits only for its own host.
    for (const host of result.hosts) {
      if (host.state === "connected") void refreshCatalog(host.hostId).catch((cause) => reportHostError(host.hostId, cause));
    }
  }, [root, clientFor, refreshCatalog, reportHostError]);
  const initialize = useCallback(async () => {
    if (root.mode === "local") {
      try {
        const saved = localStorage.getItem(LEGACY_HOSTS);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            for (const hostId of new Set(parsed.filter((item): item is string => typeof item === "string" && validSshTarget(item)))) await root.call("host.save", { hostId });
            localStorage.removeItem(LEGACY_HOSTS);
          }
        }
      } catch (cause) { reportHostError(null, `迁移已保存 SSH 电脑失败：${errorMessage(cause)}`); }
    }
    const [local, ssh] = await Promise.allSettled([refreshCatalog(null), refreshHosts()]);
    if (local.status === "rejected") throw local.reason;
    // SSH metadata is independent of the local daemon's health. A bad host
    // store or a desktop awaiting upgrade must not restart a healthy relay.
    if (ssh.status === "rejected") reportHostError(null, `SSH 电脑列表暂不可用：${errorMessage(ssh.reason)}`);
  }, [root, refreshCatalog, refreshHosts, reportHostError]);
  const connection = useDaemonConnection({ client: root, refreshWorkspaces: initialize, refreshSessions: noop, onError: setError, paused });
  useEffect(() => {
    const state = connection.connected ? "connected" : "disconnected";
    setCatalogs((current) => {
      const key = hostKey(null), catalog = current[key];
      return catalog.state === state ? current : { ...current, [key]: { ...catalog, state } };
    });
  }, [connection.connected]);
  useEffect(() => {
    const event = (host: string | null, value: DaemonEvent | { type: "remote_resync" }) => {
      if (value.type === "session_status_changed" || value.type === "turn_completed" || value.type === "turn_failed") {
        setCatalogs((current) => {
          const key = hostKey(host), catalog = current[key];
          if (!catalog) return current;
          const unread = new Set(catalog.unreadSessionIds);
          const previous = catalog.sessions.find((session) => session.id === value.sessionId);
          const completed = value.type !== "session_status_changed"
            || (isSessionTerminal(value.status) && previous && isSessionRunning(previous.status));
          if (completed && (activeRef.current.host !== host || activeRef.current.navigation.sessionId !== value.sessionId)) unread.add(value.sessionId);
          const sessions = value.type === "session_status_changed"
            ? catalog.sessions.map((session) => session.id === value.sessionId ? { ...session, status: value.status } : session)
            : catalog.sessions;
          return { ...current, [key]: { ...catalog, unreadSessionIds: unread, sessions } };
        });
      }
      if (/^(workspace_|session_(created|deleted|renamed|updated|status_changed|pinned_changed|archived_changed)|turn_(completed|failed)|remote_resync)/.test(value.type)) void refreshCatalog(host, true).catch((cause) => reportHostError(host, cause));
    };
    const offLocal = root.onEvent((value) => event(null, value));
    const offHost = root.onHostEvent((value) => {
      if (value.type === "host_changed") void refreshHosts().catch((cause) => setError(errorMessage(cause)));
      else event(value.hostId, value.event);
    });
    return () => { offLocal(); offHost(); };
  }, [root, refreshCatalog, refreshHosts, reportHostError]);
  const markSeen = useCallback((host: string | null, sessionId: string) => setCatalogs((current) => {
    const key = hostKey(host), catalog = current[key];
    if (!catalog?.unreadSessionIds.has(sessionId)) return current;
    const unreadSessionIds = new Set(catalog.unreadSessionIds);
    unreadSessionIds.delete(sessionId);
    return { ...current, [key]: { ...catalog, unreadSessionIds } };
  }), []);
  return { registry, catalogs, refreshHosts, refreshCatalog, markSeen, error, clearError, connection, reportHostError };
}
