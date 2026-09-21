import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import { isMobileLayout } from "../mobileViewport";
import { useDesktopHost } from "../desktopHost";
import { hostKey } from "../hostWorkspace";
import type {
  QueuedMessage,
  Session,
  SessionStatus,
  Workspace,
} from "../types";
import { useDaemonConnection } from "./useDaemonConnection";
import { useAppUpdater } from "./useAppUpdater";
import { useFilePreview } from "./useFilePreview";
import { useSessionLifecycleActions } from "./useSessionLifecycleActions";
import { useSessionFeed } from "./useSessionFeed";
import { useSessionModel } from "./useSessionModel";
import { useSessionDiff } from "./useSessionDiff";
import { useTaskNotifications } from "./useTaskNotifications";
import { useSessionError } from "./useSessionError";
import { isSessionRunning, isSessionTerminal } from "../sessionStatus";
import { BROWSER_DRAFT_CREATED_EVENT, type BrowserDraftCreatedDetail } from "../browserTabs";
import { useKeepAwake } from "../keepAwake";

export type AppPage = "schedule" | "skills" | "mcp" | "plugins" | null;
const PROVIDER_ONBOARDING_KEY = "miniq.providerOnboarding.v1";

async function pickDirectory(): Promise<string | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择工作区文件夹",
    });
    return typeof selected === "string" ? selected : null;
  }
  return window.prompt("工作区目录(绝对路径):");
}

function useRpcClient(): RpcClient {
  const desktop = useDesktopHost();
  const clientRef = useRef<RpcClient>();
  const lifecycle = useRef(0);
  if (!clientRef.current) clientRef.current = desktop ? desktop.clientFor(desktop.host) : new RpcClient();
  useEffect(() => {
    if (desktop) return;
    const generation = ++lifecycle.current;
    return () => {
      // Let connection/event hooks unsubscribe first. StrictMode's immediate
      // remount keeps its client; a real host switch disposes only the old one.
      queueMicrotask(() => {
        if (generation === lifecycle.current) clientRef.current?.disconnect("workspace detached");
      });
    };
  }, []);
  return clientRef.current;
}

function useCatalog(client: RpcClient) {
  const desktop = useDesktopHost();
  const cached = desktop?.catalogs[hostKey(client.sshHost)];
  const [localWorkspaces, setWorkspaces] = useState<Workspace[]>([]);
  const workspaces = cached?.workspaces ?? localWorkspaces;
  type SessionRow = Omit<Session, "workingDirectory"> & { workingDirectory?: string };
  const [localSessions, setSessions] = useState<SessionRow[]>([]);
  const sessionRows = cached?.sessions ?? localSessions;
  // The mobile website is updated before every connected desktop has migrated.
  const sessions = useMemo<Session[]>(() => sessionRows.map((session) => ({
    ...session,
    workingDirectory: session.workingDirectory ?? workspaces.find((workspace) => workspace.id === session.workspaceId)?.path ?? "",
  })), [sessionRows, workspaces]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => desktop?.destination.workspaceId ?? null);
  const [currentSessionId, setCurrentSessionState] = useState<string | null>(null);
  const navigationEpoch = useRef(0);
  const sessionRefresh = useRef<Promise<void> | null>(null);
  const sessionRefreshQueued = useRef(false);
  const setCurrentSessionId = useCallback((sessionId: string | null) => {
    navigationEpoch.current++;
    setCurrentSessionState(sessionId);
  }, []);

  const refreshSessions = useCallback(() => {
    if (desktop) return desktop.refreshCatalog(client.sshHost);
    sessionRefreshQueued.current = true;
    if (sessionRefresh.current) return sessionRefresh.current;
    sessionRefresh.current = (async () => {
      do {
        sessionRefreshQueued.current = false;
        const result = await client.call<{ sessions: SessionRow[] }>("session.list", {});
        setSessions(result.sessions);
      } while (sessionRefreshQueued.current);
    })().finally(() => { sessionRefresh.current = null; });
    return sessionRefresh.current;
  }, [client, desktop?.refreshCatalog]);

  const refreshWorkspaces = useCallback(async () => {
    if (desktop) { await desktop.refreshCatalog(client.sshHost); return; }
    type WorkspaceRow = Omit<Workspace, "additionalPaths"> & { additionalPaths?: string[] };
    const result = await client.call<{ workspaces: WorkspaceRow[] }>("workspace.list");
    setWorkspaces(result.workspaces.map((workspace) => ({ ...workspace, additionalPaths: workspace.additionalPaths ?? [] })));
  }, [client, desktop?.refreshCatalog]);

  const updateSessionStatus = useCallback(
    (sessionId: string, status: SessionStatus) => {
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, status } : session,
        ),
      );
    },
    [],
  );

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  );
  const selectedWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
      workspaces[0] ??
      null,
    [workspaces, selectedWorkspaceId],
  );
  const currentWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === currentSession?.workspaceId) ??
      null,
    [workspaces, currentSession],
  );
  const workspacePathsJson = JSON.stringify(currentWorkspace ? [currentWorkspace.path, ...currentWorkspace.additionalPaths] : []);
  const currentWorkspacePaths = useMemo(() => JSON.parse(workspacePathsJson) as string[], [workspacePathsJson]);

  return {
    workspaces,
    sessions,
    selectedWorkspaceId,
    currentSessionId,
    navigationEpoch,
    currentSession,
    selectedWorkspace,
    currentWorkspace,
    currentWorkspacePaths,
    setSelectedWorkspaceId,
    setCurrentSessionId,
    refreshSessions,
    refreshWorkspaces,
    updateSessionStatus,
  };
}

function useNavigationState() {
  const desktop = useDesktopHost();
  const [showRemoteFolder, setShowRemoteFolder] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [showExternalImport, setShowExternalImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDistill, setShowDistill] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobileLayout);
  const [page, setPage] = useState<AppPage>(null);
  return {
    showRemoteFolder,
    setShowRemoteFolder,
    editingWorkspaceId,
    setEditingWorkspaceId,
    showExternalImport,
    showSettings,
    showDistill,
    showSearch,
    sidebarCollapsed: desktop?.sidebarCollapsed ?? sidebarCollapsed,
    page,
    setShowExternalImport,
    setShowSettings,
    setShowDistill,
    setShowSearch,
    setSidebarCollapsed: desktop?.setSidebarCollapsed ?? setSidebarCollapsed,
    setPage,
  };
}

export type Catalog = ReturnType<typeof useCatalog>;
export type NavigationState = ReturnType<typeof useNavigationState>;
export type SessionFeed = ReturnType<typeof useSessionFeed>;
type ErrorSetter = (message: string | null) => void;

function useNavigationActions(
  catalog: Catalog,
  navigation: NavigationState,
  feed: SessionFeed,
) {
  const { setCurrentSessionId, setSelectedWorkspaceId } = catalog;
  const { setShowSettings, setShowSearch, setPage } = navigation;
  const { reset } = feed;

  const newChat = useCallback(() => {
    setCurrentSessionId(null);
    reset(null);
    setShowSettings(false);
    setShowSearch(false);
    setPage(null);
  }, [reset, setCurrentSessionId, setPage, setShowSearch, setShowSettings]);

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      setSelectedWorkspaceId(workspaceId);
      setCurrentSessionId(null);
      setPage(null);
      reset(null);
    },
    [reset, setCurrentSessionId, setPage, setSelectedWorkspaceId],
  );

  const selectProject = useCallback(
    (workspaceId: string) => {
      setSelectedWorkspaceId(workspaceId);
      setCurrentSessionId(null);
      reset(null);
    },
    [reset, setCurrentSessionId, setSelectedWorkspaceId],
  );

  return { newChat, selectWorkspace, selectProject };
}

function useWorkspaceActions(
  client: RpcClient,
  catalog: Catalog,
  setError: ErrorSetter,
  openRemoteFolder: () => void,
) {
  const desktop = useDesktopHost();
  const canManage = (desktop?.root ?? client).mode === "local";
  const {
    refreshWorkspaces,
    setSelectedWorkspaceId,
    setCurrentSessionId,
  } = catalog;

  const openWorkspace = useCallback(async () => {
    if (!canManage) { setError("请在桌面端添加或授权工作区目录"); return; }
    if (client.sshHost) { openRemoteFolder(); return; }
    const path = await pickDirectory();
    if (!path) return;
    try {
      const workspace = await client.call<Workspace>("workspace.open", { path });
      await refreshWorkspaces();
      setSelectedWorkspaceId(workspace.id);
      setCurrentSessionId(null);
      setError(null);
    } catch (error) {
      setError(errorMessage(error));
    }
  }, [client, canManage, refreshWorkspaces, setCurrentSessionId, setError, setSelectedWorkspaceId, openRemoteFolder]);

  const openRemoteWorkspace = useCallback(async (path: string) => {
    if (!canManage) throw new Error("请在桌面端添加或授权工作区目录");
    const workspace = await client.call<Workspace>("workspace.open", { path });
    await refreshWorkspaces();
    setSelectedWorkspaceId(workspace.id);
    setCurrentSessionId(null);
    setError(null);
  }, [client, canManage, refreshWorkspaces, setCurrentSessionId, setError, setSelectedWorkspaceId]);

  const createBlankProject = useCallback(
    async (name: string) => {
      try {
        const workspace = await client.call<Workspace>("workspace.create", { name });
        await refreshWorkspaces();
        setSelectedWorkspaceId(workspace.id);
        setCurrentSessionId(null);
        setError(null);
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [client, refreshWorkspaces, setCurrentSessionId, setError, setSelectedWorkspaceId],
  );

  const deleteWorkspace = useCallback(
    async (workspaceId: string) => {
      try {
        await client.call("workspace.delete", { workspaceId });
        await refreshWorkspaces();
        if (catalog.selectedWorkspaceId === workspaceId) {
          setSelectedWorkspaceId(null);
          setCurrentSessionId(null);
        }
      } catch (err) {
        console.error("Failed to delete workspace:", err);
        setError(err instanceof Error ? err.message : "删除项目失败");
      }
    },
    [client, catalog.selectedWorkspaceId, refreshWorkspaces, setCurrentSessionId, setError, setSelectedWorkspaceId],
  );

  const renameWorkspace = useCallback(
    async (workspaceId: string, name: string) => {
      try {
        await client.call("workspace.rename", { workspaceId, name });
        await refreshWorkspaces();
      } catch (err) {
        console.error("Failed to rename workspace:", err);
        setError(err instanceof Error ? err.message : "重命名项目失败");
      }
    },
    [client, refreshWorkspaces, setError],
  );

  return { openWorkspace, openRemoteWorkspace, createBlankProject, deleteWorkspace, renameWorkspace };
}

type SessionLifecycle = ReturnType<typeof useSessionLifecycleActions>;

function useTurnActions(
  client: RpcClient,
  catalog: Catalog,
  lifecycle: SessionLifecycle,
  setError: ErrorSetter,
  sessionModel: ReturnType<typeof useSessionModel>,
  ensureProviderConfigured: () => Promise<boolean>,
) {
  const { openSession } = lifecycle;

  const sendMessage = useCallback(
    async (content: string, attachments: string[] = []) => {
      if (!catalog.currentSessionId) return false;
      if (!await ensureProviderConfigured()) return false;
      setError(null);
      try {
        await client.call("session.sendMessage", {
          sessionId: catalog.currentSessionId,
          message: { role: "user", content, attachments },
        });
        void catalog.refreshSessions();
        return true;
      } catch (error) {
        setError(errorMessage(error));
        return false;
      }
    },
    [catalog.currentSessionId, catalog.refreshSessions, client, ensureProviderConfigured, setError],
  );

  const rewriteMessage = useCallback(
    async (messageId: string, content: string, attachments: string[] = []) => {
      if (!catalog.currentSessionId) return false;
      if (!await ensureProviderConfigured()) return false;
      setError(null);
      try {
        await client.call("session.rewriteMessage", {
          sessionId: catalog.currentSessionId,
          messageId,
          message: { role: "user", content, attachments },
        });
        void catalog.refreshSessions();
        return true;
      } catch (error) {
        setError(errorMessage(error));
        return false;
      }
    },
    [catalog.currentSessionId, catalog.refreshSessions, client, ensureProviderConfigured, setError],
  );

  const startTask = useCallback(
    async (content: string, attachments: string[] = []) => {
      if (!await ensureProviderConfigured()) return false;
      if (!sessionModel.ready || sessionModel.pending) return false;
      if (!catalog.selectedWorkspace) {
        setError("请先选择一个项目(或新建一个)");
        return false;
      }
      setError(null);
      try {
        const epoch = catalog.navigationEpoch.current;
        const session = await client.call<Session>("session.create", {
          workspaceId: catalog.selectedWorkspace.id,
          modelSettings: {
            model: sessionModel.settings.model ?? sessionModel.effective?.model ?? null,
            apiProtocol: "auto",
            reasoningEffort: sessionModel.settings.reasoningEffort,
          },
        });
        if (epoch === catalog.navigationEpoch.current) {
          window.dispatchEvent(new CustomEvent<BrowserDraftCreatedDetail>(BROWSER_DRAFT_CREATED_EVENT, {
            detail: { hostId: client.sshHost, workspaceId: catalog.selectedWorkspace.id, sessionId: session.id },
          }));
        }
        await client.call("session.sendMessage", {
          sessionId: session.id,
          message: { role: "user", content, attachments },
        });
        sessionModel.clearDraft();
        if (epoch === catalog.navigationEpoch.current) await openSession(session.id);
        void catalog.refreshSessions();
        return true;
      } catch (error) {
        setError(errorMessage(error));
        return false;
      }
    },
    [
      catalog.refreshSessions,
      catalog.selectedWorkspace,
      client,
      catalog.navigationEpoch,
      ensureProviderConfigured,
      openSession,
      setError,
      sessionModel,
    ],
  );

  const cancelTurn = useCallback(async () => {
    if (!catalog.currentSessionId) return;
    await client.call("session.cancel", { sessionId: catalog.currentSessionId });
  }, [catalog.currentSessionId, client]);

  /** Remove a message from the pending queue. */
  const removeQueued = useCallback(
    async (queuedMessageId: string) => {
      await client.call("session.queueRemove", { queuedMessageId });
    },
    [client],
  );

  /** "调整方向": promote a queued message and interrupt the running turn. */
  const steerQueued = useCallback(
    async (queuedMessageId: string) => {
      await client.call("session.queueSteer", { queuedMessageId });
    },
    [client],
  );

  const updateQueued = useCallback(
    async (original: QueuedMessage, content: string) => {
      await client.call("session.queueUpdate", {
        sessionId: original.sessionId,
        queuedMessageId: original.id,
        expectedContent: original.content,
        content,
      });
    },
    [client],
  );

  const moveQueued = useCallback(
    async (item: QueuedMessage, direction: "up" | "down") => {
      await client.call("session.queueMove", {
        sessionId: item.sessionId,
        queuedMessageId: item.id,
        expectedPosition: item.position,
        direction,
      });
    },
    [client],
  );

  return { sendMessage, rewriteMessage, startTask, cancelTurn, removeQueued, steerQueued, updateQueued, moveQueued };
}

function useInteractionActions(
  client: RpcClient,
  setError: ErrorSetter,
  refreshDiff: () => Promise<void>,
) {
  const resolveApproval = useCallback(
    async (approvalId: string, decision: string) => {
      try {
        await client.call("approval.resolve", { approvalId, decision });
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [client, setError],
  );

  const resolveQuestion = useCallback(
    (questionId: string, answer: string) =>
      client.call<void>("question.resolve", { questionId, answer }),
    [client],
  );

  const rollbackCheckpoint = useCallback(
    async (checkpointId: string) => {
      try {
        const result = await client.call<{ restored: string }>("checkpoint.rollback", {
          checkpointId,
        });
        await refreshDiff();
        setError(null);
        window.alert(`已恢复: ${result.restored}`);
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [client, refreshDiff, setError],
  );

  return { resolveApproval, resolveQuestion, rollbackCheckpoint };
}

export function useMiniqApp(active = true) {
  const desktop = useDesktopHost();
  const client = useRpcClient();
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());
  const catalog = useCatalog(client);
  const [sessionError, setError, setSessionError] = useSessionError(
    catalog.currentSessionId ?? `draft:${catalog.selectedWorkspace?.id ?? ""}`,
  );
  const sessionModel = useSessionModel(
    client,
    catalog.currentSessionId,
    catalog.selectedWorkspace?.id ?? null,
    desktop?.getModelDrafts(client.sshHost),
  );
  const markSessionSeen = useCallback((sessionId: string) => {
    desktop?.markSeen(client.sshHost, sessionId);
    setUnreadSessionIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, [desktop?.markSeen, client]);
  const handleSessionStatusChanged = useCallback(
    (sessionId: string, status: SessionStatus) => {
      const previous = catalog.sessions.find((session) => session.id === sessionId)?.status;
      catalog.updateSessionStatus(sessionId, status);
      if (
        catalog.currentSessionId !== sessionId &&
        previous &&
        isSessionRunning(previous) &&
        isSessionTerminal(status)
      ) {
        setUnreadSessionIds((current) => {
          if (current.has(sessionId)) return current;
          const next = new Set(current);
          next.add(sessionId);
          return next;
        });
      }
    },
    [catalog.currentSessionId, catalog.sessions, catalog.updateSessionStatus],
  );
  const handleSessionCompleted = useCallback(
    (sessionId: string) => {
      if (catalog.currentSessionId === sessionId) return;
      setUnreadSessionIds((current) => {
        if (current.has(sessionId)) return current;
        const next = new Set(current);
        next.add(sessionId);
        return next;
      });
    },
    [catalog.currentSessionId],
  );
  const navigation = useNavigationState();
  const feed = useSessionFeed({
    client,
    currentSessionId: catalog.currentSessionId,
    refreshSessions: catalog.refreshSessions,
    onSessionStatusChanged: handleSessionStatusChanged,
    onSessionCompleted: handleSessionCompleted,
    onError: setSessionError,
  });
  const review = useSessionDiff(client, catalog.currentSessionId, feed.toolCalls);
  const preview = useFilePreview(catalog.currentSession?.workingDirectory, catalog.currentSessionId, catalog.currentWorkspacePaths, client, desktop?.getFilePreviewCache(client.sshHost));
  useTaskNotifications(client, catalog.sessions);
  const updater = useAppUpdater(client, setConnectionError, desktop?.setTransportPaused);
  const scopedConnection = useDaemonConnection({
    client,
    refreshWorkspaces: catalog.refreshWorkspaces,
    refreshSessions: catalog.refreshSessions,
    onError: setConnectionError,
    paused: updater.state.phase === "installing" || Boolean(desktop && !client.sshHost),
  });
  const connection = desktop && !client.sshHost ? desktop.connection : scopedConnection;
  const ensureProviderConfigured = useCallback(async () => {
    if (client.mode !== "local" && !client.sshHost) return true;
    try {
      const configured = connection.providerConfigured === true
        || await connection.refreshProviderConfiguration();
      if (configured) return true;
      navigation.setShowSettings(true);
      return false;
    } catch (error) {
      setConnectionError(`无法检查模型服务设置：${errorMessage(error)}`);
      return false;
    }
  }, [client.mode, connection.providerConfigured, connection.refreshProviderConfiguration, navigation.setShowSettings]);
  useEffect(() => {
    if (
      (client.mode !== "local" && !client.sshHost) ||
      connection.connectionEpoch === 0 ||
      connection.providerConfigured !== false
    ) return;
    try {
      const key = `${PROVIDER_ONBOARDING_KEY}${client.sshHost ? `:${client.sshHost}` : ""}`;
      if (window.localStorage.getItem(key) === "seen") return;
      window.localStorage.setItem(key, "seen");
    } catch {
      // Storage can be unavailable; showing the setup screen is still safe.
    }
    navigation.setShowSettings(true);
  }, [client.mode, connection.connectionEpoch, connection.providerConfigured, navigation.setShowSettings]);
  const navigationActions = useNavigationActions(catalog, navigation, feed);
  const openRemoteFolder = useCallback(() => navigation.setShowRemoteFolder(true), [navigation.setShowRemoteFolder]);
  const workspaceActions = useWorkspaceActions(client, catalog, setError, openRemoteFolder);
  const lifecycle = useSessionLifecycleActions(
    client,
    catalog,
    navigation,
    feed,
    markSessionSeen,
    setSessionError,
    active,
  );
  const destinationRevision = useRef(-1);
  useEffect(() => {
    if (!active || !desktop || desktop.host !== client.sshHost || !connection.connected || destinationRevision.current === desktop.destination.revision) return;
    destinationRevision.current = desktop.destination.revision;
    const target = desktop.destination;
    if (target.sessionId) void lifecycle.openSession(target.sessionId);
    else if (target.workspaceId) {
      navigationActions.selectWorkspace(target.workspaceId);
      if (target.action === "edit") navigation.setEditingWorkspaceId(target.workspaceId);
      if (target.action === "create") void lifecycle.createSession(target.workspaceId);
    } else navigationActions.newChat();
  }, [active, client, desktop, connection.connected, lifecycle, navigationActions, navigation]);
  useEffect(() => {
    desktop?.rememberNavigation(client.sshHost, { workspaceId: catalog.selectedWorkspaceId, sessionId: catalog.currentSessionId });
  }, [desktop?.rememberNavigation, client, catalog.selectedWorkspaceId, catalog.currentSessionId]);
  const turnActions = useTurnActions(
    client,
    catalog,
    lifecycle,
    setError,
    sessionModel,
    ensureProviderConfigured,
  );
  const interactionActions = useInteractionActions(client, setError, review.refresh);
  const lastResyncedConnection = useRef(0);
  useEffect(() => {
    if (!active) return;
    const sessionId = catalog.currentSessionId;
    const epoch = connection.connectionEpoch;
    if (epoch === 0 || epoch === lastResyncedConnection.current) return;
    lastResyncedConnection.current = epoch;
    if (!sessionId) return;
    void lifecycle.syncSession(sessionId).catch((cause) => setError(errorMessage(cause)));
  }, [active, catalog.currentSessionId, connection.connectionEpoch, lifecycle, setError]);
  const busy =
    catalog.currentSession?.status === "running" ||
    catalog.currentSession?.status === "waiting_approval";
  // Keep the local desktop awake for any active local session, even when the
  // user switches to another conversation. Remote/mobile views and SSH
  // workspaces must never lock the viewing device or local host.
  const localTaskBusy =
    active &&
    client.mode === "local" &&
    !client.sshHost &&
    catalog.sessions.some(
      (session) => session.status === "running" || session.status === "waiting_approval",
    );
  useKeepAwake(localTaskBusy);

  return {
    client,
    sessionModel,
    error: connectionError ?? desktop?.error ?? sessionError,
    setError,
    dismissError: () => { setConnectionError(null); desktop?.clearError(); setError(null); },
    busy,
    catalog,
    unreadSessionIds,
    markSessionSeen,
    navigation,
    feed,
    review,
    preview,
    connection,
    updater,
    actions: {
      ...navigationActions,
      ...workspaceActions,
      ...lifecycle,
      ...turnActions,
      ...interactionActions,
    },
  };
}

export type MiniqAppController = ReturnType<typeof useMiniqApp>;
