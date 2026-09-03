import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import type {
  Artifact,
  Message,
  PlanTask,
  QueuedMessage,
  Session,
  SessionStatus,
  ToolCall,
  UserMessageInput,
  TurnProgress,
  Workspace,
} from "../types";
import { useDaemonConnection } from "./useDaemonConnection";
import { useAppUpdater } from "./useAppUpdater";
import { useFilePreview } from "./useFilePreview";
import { useSessionFeed } from "./useSessionFeed";
import { useSessionDiff } from "./useSessionDiff";
import { useTaskNotifications } from "./useTaskNotifications";

export type AppPage = "schedule" | "skills" | "mcp" | null;

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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    const result = await client.call<{ sessions: Session[] }>("session.list", {});
    setSessions(result.sessions);
  }, [client]);

  const refreshWorkspaces = useCallback(async () => {
    const result = await client.call<{ workspaces: Workspace[] }>("workspace.list");
    setWorkspaces(result.workspaces);
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

  return {
    workspaces,
    sessions,
    selectedWorkspaceId,
    currentSessionId,
    currentSession,
    selectedWorkspace,
    currentWorkspace,
    setSelectedWorkspaceId,
    setCurrentSessionId,
    refreshSessions,
    refreshWorkspaces,
    updateSessionStatus,
  };
}

function useNavigationState() {
  const [showExternalImport, setShowExternalImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDistill, setShowDistill] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [page, setPage] = useState<AppPage>(null);
  return {
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

type Catalog = ReturnType<typeof useCatalog>;
type NavigationState = ReturnType<typeof useNavigationState>;
type SessionFeed = ReturnType<typeof useSessionFeed>;
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
    setShowSettings(false);
    setShowSearch(false);
    setPage(null);
  }, [setCurrentSessionId, setPage, setShowSearch, setShowSettings]);

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      setSelectedWorkspaceId(workspaceId);
      setCurrentSessionId(null);
      setPage(null);
      reset();
    },
    [reset, setCurrentSessionId, setPage, setSelectedWorkspaceId],
  );

  const selectProject = useCallback(
    (workspaceId: string) => {
      setSelectedWorkspaceId(workspaceId);
      setCurrentSessionId(null);
    },
    [setCurrentSessionId, setSelectedWorkspaceId],
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

interface OpenSessionResult {
  session: Session;
  messages: Message[];
  toolCalls: ToolCall[];
  artifacts: Artifact[];
  plan: PlanTask[];
  queue: QueuedMessage[];
  approvals: SessionFeed["approvals"];
  questions: SessionFeed["questions"];
  streamingText: string;
  turnProgress: TurnProgress | null;
}

function useSessionLifecycleActions(
  client: RpcClient,
  catalog: Catalog,
  navigation: NavigationState,
  feed: SessionFeed,
  setError: ErrorSetter,
) {
  const {
    refreshSessions,
    setSelectedWorkspaceId,
    setCurrentSessionId,
  } = catalog;
  const { setPage } = navigation;
  const { reset, load } = feed;

  const createSession = useCallback(
    async (workspaceId: string) => {
      const session = await client.call<Session>("session.create", { workspaceId });
      await refreshSessions();
      setSelectedWorkspaceId(workspaceId);
      setCurrentSessionId(session.id);
      setPage(null);
      reset();
      return session;
    },
    [client, refreshSessions, reset, setCurrentSessionId, setPage, setSelectedWorkspaceId],
  );

  const openSession = useCallback(
    async (sessionId: string) => {
      const result = await client.call<OpenSessionResult>("session.open", { sessionId });
      setCurrentSessionId(sessionId);
      setSelectedWorkspaceId(result.session.workspaceId);
      setPage(null);
      load({
        messages: result.messages,
        toolCalls: result.toolCalls,
        plan: result.plan ?? [],
        artifacts: result.artifacts ?? [],
        queue: result.queue ?? [],
        approvals: result.approvals ?? [],
        questions: result.questions ?? [],
        streamingText: result.streamingText ?? "",
        turnProgress: result.turnProgress ?? null,
      });
    },
    [client, load, setCurrentSessionId, setPage, setSelectedWorkspaceId],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await client.call("session.delete", { sessionId });
        await refreshSessions();
        if (catalog.currentSessionId === sessionId) {
          setCurrentSessionId(null);
          reset();
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
        setError(err instanceof Error ? err.message : "删除会话失败");
      }
    },
    [client, catalog.currentSessionId, refreshSessions, reset, setCurrentSessionId, setError],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await client.call("session.rename", { sessionId, title });
        await refreshSessions();
      } catch (err) {
        console.error("Failed to rename session:", err);
        setError(err instanceof Error ? err.message : "重命名会话失败");
      }
    },
    [client, refreshSessions, setError],
  );

  const setSessionPinned = useCallback(
    async (sessionId: string, pinned: boolean) => {
      try {
        await client.call("session.setPinned", { sessionId, pinned });
        await refreshSessions();
      } catch (err) {
        console.error("Failed to pin/unpin session:", err);
        setError(err instanceof Error ? err.message : "置顶会话失败");
      }
    },
    [client, refreshSessions, setError],
  );

  const setSessionArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      try {
        await client.call("session.setArchived", { sessionId, archived });
        await refreshSessions();
        if (archived && catalog.currentSessionId === sessionId) {
          setCurrentSessionId(null);
          reset();
        }
      } catch (err) {
        console.error("Failed to archive session:", err);
        setError(err instanceof Error ? err.message : "归档会话失败");
      }
    },
    [client, catalog.currentSessionId, refreshSessions, reset, setCurrentSessionId, setError],
  );

  return {
    createSession,
    openSession,
    deleteSession,
    renameSession,
    setSessionPinned,
    setSessionArchived,
  };
}

type SessionLifecycle = ReturnType<typeof useSessionLifecycleActions>;

function useTurnActions(
  client: RpcClient,
  catalog: Catalog,
  lifecycle: SessionLifecycle,
  setError: ErrorSetter,
) {
  const { createSession, openSession } = lifecycle;

  const sendMessage = useCallback(
    async (message: UserMessageInput) => {
      if (!catalog.currentSessionId) return;
      setError(null);
      try {
        await client.call("session.sendMessage", {
          sessionId: catalog.currentSessionId,
          message: { role: "user", ...message },
        });
        void catalog.refreshSessions();
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [catalog.currentSessionId, catalog.refreshSessions, client, setError],
  );

  const startTask = useCallback(
    async (message: UserMessageInput) => {
      if (!catalog.selectedWorkspace) {
        setError("请先选择一个项目(或新建一个)");
        return;
      }
      setError(null);
      try {
        const session = await createSession(catalog.selectedWorkspace.id);
        await client.call("session.sendMessage", {
          sessionId: session.id,
          message: { role: "user", ...message },
        });
        await openSession(session.id);
        void catalog.refreshSessions();
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [
      catalog.refreshSessions,
      catalog.selectedWorkspace,
      client,
      createSession,
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
  const [error, setError] = useState<string | null>(null);
  const catalog = useCatalog(client);
  const navigation = useNavigationState();
  const feed = useSessionFeed({
    client,
    currentSessionId: catalog.currentSessionId,
    refreshSessions: catalog.refreshSessions,
    onSessionStatusChanged: catalog.updateSessionStatus,
    onError: setError,
  });
  const review = useSessionDiff(client, catalog.currentSessionId, feed.toolCalls);
  const preview = useFilePreview(catalog.currentWorkspace?.path);
  useTaskNotifications(client, catalog.sessions);
  const connection = useDaemonConnection({
    client,
    refreshWorkspaces: catalog.refreshWorkspaces,
    refreshSessions: catalog.refreshSessions,
    onError: setError,
  });
  const updater = useAppUpdater(client, setError);
  const navigationActions = useNavigationActions(catalog, navigation, feed);
  const workspaceActions = useWorkspaceActions(client, catalog, setError);
  const lifecycle = useSessionLifecycleActions(client, catalog, navigation, feed, setError);
  const turnActions = useTurnActions(client, catalog, lifecycle, setError);
  const interactionActions = useInteractionActions(client, setError, review.refresh);
  const lastResyncedConnection = useRef(0);
  useEffect(() => {
    const sessionId = catalog.currentSessionId;
    const epoch = connection.connectionEpoch;
    if (!sessionId || epoch === 0 || epoch === lastResyncedConnection.current) return;
    lastResyncedConnection.current = epoch;
    void lifecycle.openSession(sessionId).catch((cause) => setError(errorMessage(cause)));
  }, [catalog.currentSessionId, connection.connectionEpoch, lifecycle, setError]);
  const busy =
    catalog.currentSession?.status === "running" ||
    catalog.currentSession?.status === "waiting_approval";

  return {
    client,
    error,
    setError,
    busy,
    catalog,
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
