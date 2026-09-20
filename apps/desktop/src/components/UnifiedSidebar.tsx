import { AppSidebar } from "./AppSidebar";
import { useDesktopHost } from "../desktopHost";
import { hostKey, scopedKey } from "../hostWorkspace";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { Session } from "../types";

export function UnifiedSidebar({ app }: { app: MiniqAppController }) {
  const desktop = useDesktopHost()!;
  const catalogs = Object.values(desktop.catalogs);
  const decode = (key: string) => JSON.parse(key) as [string | null, string];
  const workspaces = catalogs.flatMap((catalog) => catalog.workspaces.map((workspace) => ({ ...workspace, id: scopedKey(catalog.hostId, workspace.id) })));
  const sessions = catalogs.flatMap((catalog) => catalog.sessions.map((session) => ({ ...session, id: scopedKey(catalog.hostId, session.id), workspaceId: scopedKey(catalog.hostId, session.workspaceId) })));
  const select = (key: string, kind: "workspace" | "session", action?: "edit" | "create") => {
    const [host, id] = decode(key);
    const workspaceId = kind === "workspace" ? id : desktop.catalogs[hostKey(host)]?.sessions.find((session) => session.id === id)?.workspaceId ?? null;
    void desktop.selectHost(host, { workspaceId, sessionId: kind === "session" ? id : null, action });
  };
  const mutate = async (key: string, method: string, idKey: "workspaceId" | "sessionId", params = {}) => {
    const [host, id] = decode(key);
    try {
      if (host === app.client.sshHost && method === "session.delete") { await app.actions.deleteSession(id); return; }
      if (host === app.client.sshHost && method === "workspace.delete") { await app.actions.deleteWorkspace(id); return; }
      if (host === app.client.sshHost && method === "session.setArchived") { await app.actions.setSessionArchived(id, Boolean((params as { archived?: boolean }).archived)); return; }
      await desktop.clientFor(host).call(method, { [idKey]: id, ...params });
      await desktop.refreshCatalog(host);
      if (host === desktop.host) await Promise.all([app.catalog.refreshSessions(), app.catalog.refreshWorkspaces()]);
    } catch (cause) { desktop.reportHostError(host, cause); }
  };
  const createSession = async (key: string) => {
    const [host, workspaceId] = decode(key);
    try {
      if (host !== null) await desktop.root.call("host.connect", { hostId: host });
      const session = await desktop.clientFor(host).call<Session>("session.create", { workspaceId });
      await desktop.refreshCatalog(host, true);
      await desktop.selectHost(host, { workspaceId, sessionId: session.id });
    } catch (cause) { desktop.reportHostError(host, cause); }
  };
  const virtual: MiniqAppController = {
    ...app,
    catalog: { ...app.catalog, workspaces, sessions,
      currentSessionId: app.catalog.currentSessionId ? scopedKey(desktop.host, app.catalog.currentSessionId) : null,
      selectedWorkspace: app.catalog.selectedWorkspace ? { ...app.catalog.selectedWorkspace, id: scopedKey(app.client.sshHost, app.catalog.selectedWorkspace.id) } : app.catalog.selectedWorkspace,
    },
    unreadSessionIds: new Set(catalogs.flatMap((catalog) => [...catalog.unreadSessionIds].map((id) => scopedKey(catalog.hostId, id)))),
    markSessionSeen: (key) => { const [host, id] = decode(key); desktop.markSeen(host, id); },
    navigation: { ...app.navigation, setEditingWorkspaceId: (value) => { if (typeof value === "string") select(value, "workspace", "edit"); } },
    actions: { ...app.actions,
      selectWorkspace: (key) => select(key, "workspace"),
      openSession: async (key) => select(key, "session"),
      deleteWorkspace: (key) => mutate(key, "workspace.delete", "workspaceId"),
      renameWorkspace: (key, name) => mutate(key, "workspace.rename", "workspaceId", { name }),
      deleteSession: (key) => mutate(key, "session.delete", "sessionId"),
      renameSession: (key, title) => mutate(key, "session.rename", "sessionId", { title }),
      setSessionPinned: (key, pinned) => mutate(key, "session.setPinned", "sessionId", { pinned }),
      setSessionArchived: (key, archived) => mutate(key, "session.setArchived", "sessionId", { archived }),
    },
  };
  return <AppSidebar app={virtual} onCreateSession={(key) => void createSession(key)} hostGroups={catalogs.map((catalog) => ({
    key: hostKey(catalog.hostId), label: catalog.hostId === null ? (desktop.root.mode === "remote" ? "远程桌面" : "本机") : catalog.label,
    state: catalog.state, error: catalog.error, selected: catalog.hostId === desktop.host,
    workspaceIds: catalog.workspaces.map((workspace) => scopedKey(catalog.hostId, workspace.id)),
    onSelect: () => void desktop.selectHost(catalog.hostId),
  }))} />;
}
