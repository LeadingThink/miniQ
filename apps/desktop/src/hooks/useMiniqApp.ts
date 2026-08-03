import { useCallback, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import type {
  Artifact,
  Message,
  PlanTask,
  Session,
  SessionStatus,
  ToolCall,
  Workspace,
} from "../types";
import { useDaemonConnection } from "./useDaemonConnection";
import { useAppUpdater } from "./useAppUpdater";
import { useFilePreview } from "./useFilePreview";
import { useSessionFeed } from "./useSessionFeed";
import { useSessionDiff } from "./useSessionDiff";

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
  const [page, setPage] = useState<AppPage>(null);
  return {
    showExternalImport,
    showSettings,
    showDistill,
    showSearch,
    page,
    setShowExternalImport,
    setShowSettings,
    setShowDistill,
    setShowSearch,
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

  return { openWorkspace, createBlankProject };
}

interface OpenSessionResult {
  session: Session;
  messages: Message[];
  toolCalls: ToolCall[];
  artifacts: Artifact[];
  plan: PlanTask[];
}

function useSessionLifecycleActions(
  client: RpcClient,
  catalog: Catalog,
  navigation: NavigationState,
  feed: SessionFeed,
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
      });
    },
    [client, load, setCurrentSessionId, setPage, setSelectedWorkspaceId],
  );

  return { createSession, openSession };
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
    async (content: string) => {
      if (!catalog.currentSessionId) return;
      setError(null);
      try {
        await client.call("session.sendMessage", {
          sessionId: catalog.currentSessionId,
          message: { role: "user", content },
        });
        void catalog.refreshSessions();
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [catalog.currentSessionId, catalog.refreshSessions, client, setError],
  );

  const startTask = useCallback(
    async (content: string) => {
      if (!catalog.selectedWorkspace) {
        setError("请先选择一个项目(或新建一个)");
        return;
      }
      setError(null);
      try {
        const session = await createSession(catalog.selectedWorkspace.id);
        await client.call("session.sendMessage", {
          sessionId: session.id,
          message: { role: "user", content },
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

  return { sendMessage, startTask, cancelTurn };
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
  const connection = useDaemonConnection({
    client,
    refreshWorkspaces: catalog.refreshWorkspaces,
    refreshSessions: catalog.refreshSessions,
    onError: setError,
  });
  const updater = useAppUpdater(client, setError);
  const navigationActions = useNavigationActions(catalog, navigation, feed);
  const workspaceActions = useWorkspaceActions(client, catalog, setError);
  const lifecycle = useSessionLifecycleActions(client, catalog, navigation, feed);
  const turnActions = useTurnActions(client, catalog, lifecycle, setError);
  const interactionActions = useInteractionActions(client, setError, review.refresh);
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
