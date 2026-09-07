import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import type {
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
import type { SessionModelSettings } from "../modelSelection";
import { useSessionDiff } from "./useSessionDiff";
import { useTaskNotifications } from "./useTaskNotifications";
import { useSessionError } from "./useSessionError";
import { isSessionRunning, isSessionTerminal } from "../sessionStatus";

export type AppPage = "schedule" | "skills" | "mcp" | "plugins" | null;

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
  const clientRef = useRef<RpcClient>();
  if (!clientRef.current) clientRef.current = new RpcClient();
  return clientRef.current;
}

function useCatalog(client: RpcClient) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  type SessionRow = Omit<Session, "workingDirectory"> & { workingDirectory?: string };
  const [sessionRows, setSessions] = useState<SessionRow[]>([]);
  // The mobile website is updated before every connected desktop has migrated.
  const sessions = useMemo<Session[]>(() => sessionRows.map((session) => ({
    ...session,
    workingDirectory: session.workingDirectory ?? workspaces.find((workspace) => workspace.id === session.workspaceId)?.path ?? "",
  })), [sessionRows, workspaces]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionState] = useState<string | null>(null);
  const navigationEpoch = useRef(0);
  const sessionRefresh = useRef<Promise<void> | null>(null);
  const sessionRefreshQueued = useRef(false);
  const setCurrentSessionId = useCallback((sessionId: string | null) => {
    navigationEpoch.current++;
    setCurrentSessionState(sessionId);
  }, []);

  const refreshSessions = useCallback(() => {
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
  }, [client]);

  const refreshWorkspaces = useCallback(async () => {
    type WorkspaceRow = Omit<Workspace, "additionalPaths"> & { additionalPaths?: string[] };
    const result = await client.call<{ workspaces: WorkspaceRow[] }>("workspace.list");
    setWorkspaces(result.workspaces.map((workspace) => ({ ...workspace, additionalPaths: workspace.additionalPaths ?? [] })));
  }, [client]);

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
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [showExternalImport, setShowExternalImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDistill, setShowDistill] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches,
  );
  const [page, setPage] = useState<AppPage>(null);
  return {
    editingWorkspaceId,
    setEditingWorkspaceId,
    showExternalImport,
    showSettings,
    showDistill,
    showSearch,
    sidebarCollapsed,
    page,
    setShowExternalImport,
    setShowSettings,
    setShowDistill,
    setShowSearch,
    setSidebarCollapsed,
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
) {
  const {
    refreshWorkspaces,
    setSelectedWorkspaceId,
    setCurrentSessionId,
  } = catalog;

  const openWorkspace = useCallback(async () => {
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
  }, [client, refreshWorkspaces, setCurrentSessionId, setError, setSelectedWorkspaceId]);

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

  return { openWorkspace, createBlankProject, deleteWorkspace, renameWorkspace };
}

type SessionLifecycle = ReturnType<typeof useSessionLifecycleActions>;

function useTurnActions(
  client: RpcClient,
  catalog: Catalog,
  lifecycle: SessionLifecycle,
  setError: ErrorSetter,
  modelSettings: SessionModelSettings,
) {
  const { openSession } = lifecycle;

  const sendMessage = useCallback(
    async (content: string, attachments: string[] = []) => {
      if (!catalog.currentSessionId) return false;
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
    [catalog.currentSessionId, catalog.refreshSessions, client, setError],
  );

  const startTask = useCallback(
    async (content: string, attachments: string[] = []) => {
      if (!catalog.selectedWorkspace) {
        setError("请先选择一个项目(或新建一个)");
        return false;
      }
      setError(null);
      try {
        const epoch = catalog.navigationEpoch.current;
        const session = await client.call<Session>("session.create", { workspaceId: catalog.selectedWorkspace.id });
        await client.call("session.modelUpdate", { sessionId: session.id, settings: modelSettings });
        await client.call("session.sendMessage", {
          sessionId: session.id,
          message: { role: "user", content, attachments },
        });
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
      modelSettings,
      catalog.navigationEpoch,
      openSession,
      setError,
    ],
  );

  const cancelTurn = useCallback(async () => {
    if (!catalog.currentSessionId) return;
    await client.call("session.cancel", { sessionId: catalog.currentSessionId });
  }, [catalog.currentSessionId, client]);

  /** Remove a message from the pending queue. */
  const removeQueued = useCallback(
    async (queuedMessageId: string) => {
      try {
        await client.call("session.queueRemove", { queuedMessageId });
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [client, setError],
  );

  /** "调整方向": promote a queued message and interrupt the running turn. */
  const steerQueued = useCallback(
    async (queuedMessageId: string) => {
      try {
        await client.call("session.queueSteer", { queuedMessageId });
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [client, setError],
  );

  return { sendMessage, startTask, cancelTurn, removeQueued, steerQueued };
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
    async (questionId: string, answer: string) => {
      try {
        await client.call("question.resolve", { questionId, answer });
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [client, setError],
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

export function useMiniqApp() {
  const client = useRpcClient();
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());
  const catalog = useCatalog(client);
  const [sessionError, setError, setSessionError] = useSessionError(
    catalog.currentSessionId ?? `draft:${catalog.selectedWorkspace?.id ?? ""}`,
  );
  const sessionModel = useSessionModel(client, catalog.currentSessionId);
  const markSessionSeen = useCallback((sessionId: string) => {
    setUnreadSessionIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, []);
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
  const preview = useFilePreview(catalog.currentSession?.workingDirectory, catalog.currentSessionId, catalog.currentWorkspacePaths);
  useTaskNotifications(client, catalog.sessions);
  const updater = useAppUpdater(client, setConnectionError);
  const connection = useDaemonConnection({
    client,
    refreshWorkspaces: catalog.refreshWorkspaces,
    refreshSessions: catalog.refreshSessions,
    onError: setConnectionError,
    paused: updater.state.phase === "installing",
  });
  const navigationActions = useNavigationActions(catalog, navigation, feed);
  const workspaceActions = useWorkspaceActions(client, catalog, setError);
  const lifecycle = useSessionLifecycleActions(
    client,
    catalog,
    navigation,
    feed,
    markSessionSeen,
    setSessionError,
  );
  const turnActions = useTurnActions(client, catalog, lifecycle, setError, sessionModel.settings);
  const interactionActions = useInteractionActions(client, setError, review.refresh);
  const lastResyncedConnection = useRef(0);
  useEffect(() => {
    const sessionId = catalog.currentSessionId;
    const epoch = connection.connectionEpoch;
    if (epoch === 0 || epoch === lastResyncedConnection.current) return;
    lastResyncedConnection.current = epoch;
    if (!sessionId) return;
    void lifecycle.syncSession(sessionId).catch((cause) => setError(errorMessage(cause)));
  }, [catalog.currentSessionId, connection.connectionEpoch, lifecycle, setError]);
  const busy =
    catalog.currentSession?.status === "running" ||
    catalog.currentSession?.status === "waiting_approval";

  return {
    client,
    sessionModel,
    error: connectionError ?? sessionError,
    setError,
    dismissError: () => { setConnectionError(null); setError(null); },
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
