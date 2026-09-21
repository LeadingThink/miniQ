import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "./errorMessage";
import { RpcClient } from "./rpc";
import { HostRpcClient } from "./hostRpc";
import { hostKey, validSshTarget, type HostDestination, type HostNavigation } from "./hostWorkspace";
import { useHostCatalogs } from "./hooks/useHostCatalogs";
import { isMobileLayout } from "./mobileViewport";
import type { SessionModelSettings } from "./modelSelection";
import { PreviewViewStore } from "./previewViewState";
import type { FilePreviewCache } from "./hooks/useFilePreview";
import { hasLocalRunningTasks, useKeepAwake } from "./keepAwake";
import { useTaskNotifications } from "./hooks/useTaskNotifications";

type Destination = Omit<HostDestination, "revision">;
type DesktopHost = ReturnType<typeof useHostState>;
const Context = createContext<DesktopHost | null>(null);

function useHostState(suppliedRoot?: RpcClient) {
  const [root] = useState(() => suppliedRoot ?? new RpcClient());
  const clients = useRef(new Map<string, HostRpcClient>());
  const clientFor = useCallback((host: string | null): RpcClient => {
    if (host === null) return root;
    let client = clients.current.get(host);
    if (!client) { client = new HostRpcClient(root, host); clients.current.set(host, client); }
    return client;
  }, [root]);
  const [host, setHost] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobileLayout);
  const [transportPaused, setTransportPaused] = useState(false);
  const [destination, setDestination] = useState<HostDestination>({ workspaceId: null, sessionId: null, revision: 0 });
  const locations = useRef(new Map<string, HostNavigation>());
  const modelDrafts = useRef(new Map<string, Map<string | null, SessionModelSettings>>());
  const filePreviews = useRef(new Map<string, FilePreviewCache>());
  const getFilePreviewCache = useCallback((target: string | null) => {
    const key = hostKey(target);
    let cache = filePreviews.current.get(key);
    if (!cache) { cache = { sessions: {}, views: new PreviewViewStore() }; filePreviews.current.set(key, cache); }
    return cache;
  }, []);
  const getModelDrafts = useCallback((target: string | null) => {
    const key = hostKey(target);
    let drafts = modelDrafts.current.get(key);
    if (!drafts) { drafts = new Map(); modelDrafts.current.set(key, drafts); }
    return drafts;
  }, []);
  const rememberNavigation = useCallback((target: string | null, navigation: HostNavigation) => { locations.current.set(hostKey(target), navigation); }, []);
  const catalogs = useHostCatalogs(root, clientFor, { host, navigation: locations.current.get(hostKey(host)) ?? destination }, transportPaused);
  // The root outlives host/conversation views; only local tasks hold this lease.
  useKeepAwake(hasLocalRunningTasks(root.mode, catalogs.catalogs[hostKey(null)]?.sessions ?? []));
  useTaskNotifications(root, catalogs.catalogs);
  const clearError = useCallback(() => { setError(null); catalogs.clearError(); }, [catalogs.clearError]);
  const registryRef = useRef(catalogs.registry);
  registryRef.current = catalogs.registry;
  useEffect(() => {
    for (const catalog of Object.values(catalogs.catalogs)) {
      if (catalog.state !== "connected") continue;
      const key = hostKey(catalog.hostId), location = locations.current.get(key);
      if (!location) continue;
      const workspaceId = catalog.workspaces.some((workspace) => workspace.id === location.workspaceId) ? location.workspaceId : null;
      const sessionId = catalog.sessions.some((session) => session.id === location.sessionId) ? location.sessionId : null;
      locations.current.set(key, { workspaceId, sessionId });
    }
  }, [catalogs.catalogs]);
  const switching = useRef(0);
  const selectHost = useCallback(async (next: string | null, requested?: Destination) => {
    const generation = ++switching.current;
    setPending(true); setError(null);
    try {
      if (next !== null) {
        if (!validSshTarget(next)) throw new Error("请输入 SSH 主机别名或 user@hostname");
        const saved = registryRef.current.hosts.find((item) => item.hostId === next);
        if (!saved && root.mode !== "local") throw new Error("请先在桌面端添加 SSH 电脑，移动端只能连接已保存的电脑");
        if (!saved) await root.call("host.save", { hostId: next });
        if (saved?.state !== "connected" || !clientFor(next).connected) {
          await root.call("host.connect", { hostId: next });
          (clientFor(next) as HostRpcClient).setAvailable(true);
          await catalogs.refreshHosts();
          await catalogs.refreshCatalog(next);
        }
      }
      const navigation = requested ?? locations.current.get(hostKey(next)) ?? { workspaceId: null, sessionId: null };
      if (generation !== switching.current) return;
      setHost(next);
      setDestination((old) => ({ ...navigation, revision: old.revision + 1 }));
    } catch (cause) { if (generation === switching.current) setError(errorMessage(cause)); }
    finally { if (generation === switching.current) setPending(false); }
  }, [root, clientFor, catalogs.refreshCatalog, catalogs.refreshHosts]);
  const saveHost = useCallback(async (hostId: string) => {
    if (root.mode !== "local") throw new Error("请在桌面端添加 SSH 电脑");
    if (!validSshTarget(hostId)) throw new Error("请输入有效的 SSH 主机地址");
    await root.call("host.save", { hostId }); await catalogs.refreshHosts();
  }, [root, catalogs.refreshHosts]);
  const disconnectHost = useCallback(async (hostId: string) => {
    if (host === hostId) await selectHost(null);
    await root.call("host.disconnect", { hostId }); await catalogs.refreshHosts();
  }, [root, host, selectHost, catalogs.refreshHosts]);
  const removeHost = useCallback(async (hostId: string) => {
    if (root.mode !== "local") throw new Error("请在桌面端移除 SSH 电脑");
    if (host === hostId) await selectHost(null);
    await root.call("host.remove", { hostId }); await catalogs.refreshHosts();
  }, [root, host, selectHost, catalogs.refreshHosts]);
  const lifecycle = useRef(0);
  useEffect(() => {
    const generation = ++lifecycle.current;
    return () => { queueMicrotask(() => { if (generation === lifecycle.current) root.disconnect("workbench detached"); }); };
  }, [root]);
  return useMemo(() => ({ ...catalogs, root, host, pending, error: error ?? catalogs.error, clearError, selectHost, clientFor,
    destination, sidebarCollapsed, setSidebarCollapsed, rememberNavigation, getModelDrafts, getFilePreviewCache,
    setTransportPaused,
    saveHost, removeHost, disconnectHost }),
  [root, host, pending, error, clearError, selectHost, clientFor, destination, sidebarCollapsed, rememberNavigation, getModelDrafts, getFilePreviewCache, saveHost, removeHost, disconnectHost, catalogs]);
}

/** Transport, host catalogs and sidebar outlive any individual execution view. */
export function DesktopHostProvider({ children, root }: { children: ReactNode; root?: RpcClient }) {
  const value = useHostState(root);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useDesktopHost = () => useContext(Context);
export function hostDraftKey(host: string | null | undefined, key: string) {
  return host ? `ssh:${encodeURIComponent(host)}:${key}` : key;
}
