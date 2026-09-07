import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import type { Artifact, Message, PlanTask, QueuedMessage, Session, ToolCall, TurnProgress, HistoryPage, HistoryCursor, EventCursor, DaemonEvent } from "../types";
import type { Catalog, NavigationState, SessionFeed } from "./useMiniqApp";

interface OpenSessionResult {
  eventCursor?: EventCursor | null;
  nextCursor?: HistoryCursor | null;
  session: Session;
  canAcknowledgeFailure?: boolean;
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

export function useSessionLifecycleActions(
  client: RpcClient,
  catalog: Catalog,
  navigation: NavigationState,
  feed: SessionFeed,
  markSessionSeen: (sessionId: string) => void,
  setSessionError: (sessionId: string, message: string | null) => void,
) {
  const {
    refreshSessions,
    setSelectedWorkspaceId,
    setCurrentSessionId,
  } = catalog;
  const { setPage } = navigation;
  const { reset, load, prepend, failLoad, applyReplay } = feed;
  const opening = useRef<AbortController | null>(null);
  const openingSession = useRef<string | null>(null);
  const paging = useRef<AbortController | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => () => { opening.current?.abort(); paging.current?.abort(); }, []);
  useEffect(() => {
    client.selectSession?.(catalog.currentSessionId);
    if (openingSession.current !== catalog.currentSessionId) opening.current?.abort();
    paging.current?.abort();
    paging.current = null;
    setLoadingOlder(false);
  }, [catalog.currentSessionId, client]);

  const createSession = useCallback(
    async (workspaceId: string) => {
      const session = await client.call<Session>("session.create", { workspaceId });
      await refreshSessions();
      setSelectedWorkspaceId(workspaceId);
      setCurrentSessionId(session.id);
      setPage(null);
      reset(session.id);
      failLoad(session.id);
      return session;
    },
    [client, refreshSessions, reset, failLoad, setCurrentSessionId, setPage, setSelectedWorkspaceId],
  );

  const openSession = useCallback(
    async (sessionId: string, markSeen = true) => {
      opening.current?.abort();
      paging.current?.abort();
      paging.current = null;
      setLoadingOlder(false);
      const request = new AbortController();
      opening.current = request;
      openingSession.current = sessionId;
      setCurrentSessionId(sessionId);
      const epoch = catalog.navigationEpoch.current;
      reset(sessionId);
      setPage(null);
      let result: OpenSessionResult;
      try { result = await client.call<OpenSessionResult>("session.open", { sessionId }, { signal: request.signal }); }
      catch (cause) {
        if (!request.signal.aborted) { failLoad(sessionId); setSessionError(sessionId, errorMessage(cause)); }
        return;
      }
      if (epoch !== catalog.navigationEpoch.current) return;
      if (markSeen) markSessionSeen(sessionId);
      setSelectedWorkspaceId(result.session.workspaceId);
      setPage(null);
      load(sessionId, {
        eventCursor: result.eventCursor,
        nextCursor: result.nextCursor,
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
      if (markSeen && result.canAcknowledgeFailure && result.session.status === "failed") {
        try {
          await client.call("session.acknowledgeFailure", {
            sessionId,
            updatedAt: result.session.updatedAt,
          });
          await refreshSessions();
        } catch (cause) {
          setSessionError(sessionId, errorMessage(cause));
        }
      }
    },
    [client, load, failLoad, markSessionSeen, refreshSessions, reset, setCurrentSessionId, setPage, setSelectedWorkspaceId, catalog.navigationEpoch, setSessionError],
  );

  const syncSession = useCallback(async (sessionId: string) => {
    const cursor = feed.eventCursor;
    if (!cursor || feed.loading) { await openSession(sessionId, false); return; }
    const epoch = catalog.navigationEpoch.current;
    let result: { events: DaemonEvent[] | null; eventCursor: EventCursor };
    try { result = await client.call("session.sync", { sessionId, cursor }); }
    catch {
      if (epoch === catalog.navigationEpoch.current) await openSession(sessionId, false);
      return;
    }
    if (epoch !== catalog.navigationEpoch.current) return;
    if (result.events === null) await openSession(sessionId, false);
    else applyReplay(sessionId, result.events, result.eventCursor);
  }, [feed.eventCursor, feed.loading, openSession, catalog.navigationEpoch, client, applyReplay]);

  const loadOlder = useCallback(async () => {
    const sessionId = catalog.currentSessionId;
    if (!sessionId || !feed.nextCursor || paging.current) return;
    const request = new AbortController();
    paging.current = request;
    setLoadingOlder(true);
    try {
      const page = await client.call<HistoryPage>("session.history", { sessionId, before: feed.nextCursor }, { signal: request.signal });
      if (!request.signal.aborted) prepend(sessionId, page);
    } catch (cause) {
      if (!request.signal.aborted) setSessionError(sessionId, errorMessage(cause));
    } finally {
      if (paging.current === request) { paging.current = null; setLoadingOlder(false); }
    }
  }, [catalog.currentSessionId, client, feed.nextCursor, prepend, setSessionError]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await client.call("session.delete", { sessionId });
        await refreshSessions();
        if (catalog.currentSessionId === sessionId) {
          setCurrentSessionId(null);
          reset(null);
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
        setSessionError(sessionId, errorMessage(err));
      }
    },
    [client, catalog.currentSessionId, refreshSessions, reset, setCurrentSessionId, setSessionError],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await client.call("session.rename", { sessionId, title });
        await refreshSessions();
      } catch (err) {
        console.error("Failed to rename session:", err);
        setSessionError(sessionId, errorMessage(err));
      }
    },
    [client, refreshSessions, setSessionError],
  );

  const setSessionPinned = useCallback(
    async (sessionId: string, pinned: boolean) => {
      try {
        await client.call("session.setPinned", { sessionId, pinned });
        await refreshSessions();
      } catch (err) {
        console.error("Failed to pin/unpin session:", err);
        setSessionError(sessionId, errorMessage(err));
      }
    },
    [client, refreshSessions, setSessionError],
  );

  const setSessionArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      try {
        await client.call("session.setArchived", { sessionId, archived });
        await refreshSessions();
        if (archived && catalog.currentSessionId === sessionId) {
          setCurrentSessionId(null);
          reset(null);
        }
      } catch (err) {
        console.error("Failed to archive session:", err);
        setSessionError(sessionId, errorMessage(err));
      }
    },
    [client, catalog.currentSessionId, refreshSessions, reset, setCurrentSessionId, setSessionError],
  );

  return {
    createSession,
    openSession,
    syncSession,
    loadOlder,
    loadingOlder,
    deleteSession,
    renameSession,
    setSessionPinned,
    setSessionArchived,
  };
}
