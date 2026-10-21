import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import type { Artifact, Message, PlanTask, ProcessSummary, QueuedMessage, Session, SessionTurnOutcome, ToolCall, TurnProgress, HistoryPage, HistoryCursor, EventCursor, DaemonEvent } from "../types";
import type { Catalog, NavigationState, SessionFeed } from "./useMiniqApp";

interface OpenSessionResult {
  lastTurn?: SessionTurnOutcome | null;
  latestTurnTiming?: import("../types").AnchoredTurnTiming | null;
  eventCursor?: EventCursor | null;
  nextCursor?: HistoryCursor | null;
  processSummaries?: ProcessSummary[];
  session: Session;
  canAcknowledgeFailure?: boolean;
  messages: Message[];
  toolCalls: ToolCall[];
  artifacts: Artifact[];
  plan: PlanTask[];
  turnPlans?: import("../types").TurnPlan[];
  queue: QueuedMessage[];
  approvals: SessionFeed["approvals"];
  questions: SessionFeed["questions"];
  streamingText: string;
  turnProgress: TurnProgress | null;
  goal?: import("../types").SessionGoal | null;
}

// Remote history is loaded in two phases. The first response should contain
// enough recent context to render the conversation. The next page is fetched
// in the background and merged before the user reaches older content.
const REMOTE_INITIAL_HISTORY_LIMIT = 16;
const REMOTE_PREFETCH_HISTORY_LIMIT = 24;

interface HistoryRequest {
  controller: AbortController;
  sessionId: string;
  epoch: number;
  wanted: boolean;
  promise: Promise<void | { error: unknown }>;
}

function cursorKey(cursor: HistoryCursor) {
  return JSON.stringify([cursor.at, cursor.id]);
}

export function useSessionLifecycleActions(
  client: RpcClient,
  catalog: Catalog,
  navigation: NavigationState,
  feed: SessionFeed,
  markSessionSeen: (sessionId: string) => void,
  setSessionError: (sessionId: string, message: string | null) => void,
  active = true,
) {
  const {
    refreshSessions,
    setSelectedWorkspaceId,
    setCurrentSessionId,
  } = catalog;
  const { setPage } = navigation;
  const { reset, load, prepend, failLoad, applyReplay } = feed;
  const opening = useRef<AbortController | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const openingSession = useRef<string | null>(null);
  const paging = useRef<HistoryRequest | null>(null);
  const consumed = useRef(new Set<string>());
  const historySession = useRef(catalog.currentSessionId);
  const prefetchPinned = useRef(true);
  const prefetched = useRef<{ sessionId: string; epoch: number; cursor: HistoryCursor; page: HistoryPage } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => () => {
    opening.current?.abort();
    paging.current?.controller.abort();
    paging.current = null;
    consumed.current.clear();
    prefetched.current = null;
  }, [client]);
  useEffect(() => {
    if (!active) {
      catalog.navigationEpoch.current++;
      opening.current?.abort();
      paging.current?.controller.abort();
      paging.current = null;
      prefetched.current = null;
      setLoadingOlder(false);
      if (catalog.currentSessionId) failLoad(catalog.currentSessionId);
      return;
    }
    client.selectSession?.(catalog.currentSessionId);
    if (openingSession.current !== catalog.currentSessionId) opening.current?.abort();
    // A catalog commit can follow an already-returned open response. Keep
    // history started for that same selection alive.
    if (paging.current && (
      paging.current.sessionId !== catalog.currentSessionId ||
      paging.current.epoch !== catalog.navigationEpoch.current
    )) {
      paging.current.controller.abort();
      paging.current = null;
      setLoadingOlder(false);
    }
    if (historySession.current !== catalog.currentSessionId) {
      historySession.current = catalog.currentSessionId;
      consumed.current.clear();
      prefetched.current = null;
    }
  }, [catalog.currentSessionId, client, active]);

  const fetchHistory = useCallback((sessionId: string, cursor: HistoryCursor, background = false) => {
    const controller = new AbortController();
    const epoch = catalog.navigationEpoch.current;
    const pending: HistoryRequest = { controller, sessionId, epoch, wanted: !background, promise: Promise.resolve() };
    paging.current = pending;
    if (!background) setLoadingOlder(true);
    const current = () => !controller.signal.aborted && activeRef.current && epoch === catalog.navigationEpoch.current;
    pending.promise = (async () => {
      try {
        // The visible view counts only what the conversation shows outside
        // folded work, so each page adds readable content rather than tool rows.
        const page = await client.call<HistoryPage>("session.history", {
          sessionId, before: cursor, view: "visible",
          ...(background ? { limit: REMOTE_PREFETCH_HISTORY_LIMIT } : {}),
        }, { signal: controller.signal });
        if (!current()) return;
        if (background && !prefetchPinned.current && !pending.wanted) {
          // The older-history action merges this one page with its viewport
          // anchor. Background work must not move an unpinned reader.
          prefetched.current = { sessionId, epoch, cursor, page };
        } else {
          // Hold the consumed cursor through the reducer's next commit.
          consumed.current.add(cursorKey(cursor));
          prepend(sessionId, page);
        }
      } catch (cause) {
        // The requesting view owns retry/error presentation. Resolve failures
        // so fire-and-forget prefetch callers remain safe.
        if (current()) return { error: cause };
      } finally {
        if (paging.current === pending) {
          paging.current = null;
          setLoadingOlder(false);
        }
      }
    })();
    return pending.promise;
  }, [catalog.navigationEpoch, client, prepend, setSessionError]);

  const setHistoryPrefetchPinned = useCallback((pinned: boolean) => {
    prefetchPinned.current = pinned;
  }, []);

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
      if (!activeRef.current) return;
      opening.current?.abort();
      paging.current?.controller.abort();
      paging.current = null;
      consumed.current.clear();
      prefetched.current = null;
      historySession.current = sessionId;
      prefetchPinned.current = true;
      setLoadingOlder(false);
      const request = new AbortController();
      opening.current = request;
      openingSession.current = sessionId;
      setCurrentSessionId(sessionId);
      const epoch = catalog.navigationEpoch.current;
      reset(sessionId);
      setPage(null);
      let result: OpenSessionResult;
      // The desktop daemon is local and can afford a larger first page. Keep
      // remote opens small and older pages explicit. Local Timeline scrolling
      // transparently fetches older pages as the reader reaches the top.
      const initialHistoryLimit = client.mode === "local" ? 100 : REMOTE_INITIAL_HISTORY_LIMIT;
      try {
        result = await client.call<OpenSessionResult>(
          "session.open",
          { sessionId, limit: initialHistoryLimit, view: "visible" },
          { signal: request.signal },
        );
      }
      catch (cause) {
        if (!request.signal.aborted && epoch === catalog.navigationEpoch.current) {
          failLoad(sessionId);
          setSessionError(sessionId, errorMessage(cause));
        }
        return;
      }
      if (request.signal.aborted || epoch !== catalog.navigationEpoch.current) return;
      if (markSeen) markSessionSeen(sessionId);
      setSelectedWorkspaceId(result.session.workspaceId);
      setPage(null);
      load(sessionId, {
        lastTurn: result.lastTurn ?? null,
        eventCursor: result.eventCursor,
        nextCursor: result.nextCursor,
        processSummaries: result.processSummaries ?? [],
        messages: result.messages,
        toolCalls: result.toolCalls,
        plan: result.plan ?? [],
        turnPlans: result.turnPlans ?? [],
        artifacts: result.artifacts ?? [],
        queue: result.queue ?? [],
        approvals: result.approvals ?? [],
        questions: result.questions ?? [],
        streamingText: result.streamingText ?? "",
        turnProgress: result.turnProgress ?? null,
        goal: result.goal ?? null,
        latestTurnTiming: result.latestTurnTiming ?? null,
      });
      if (
        client.mode === "remote" &&
        result.nextCursor &&
        epoch === catalog.navigationEpoch.current &&
        openingSession.current === sessionId &&
        !request.signal.aborted
      ) {
        void fetchHistory(sessionId, result.nextCursor, true);
      }
      if (markSeen && result.canAcknowledgeFailure && result.session.status === "failed") {
        try {
          await client.call("session.acknowledgeFailure", {
            sessionId,
            updatedAt: result.session.updatedAt,
          }, { signal: request.signal });
          if (request.signal.aborted || epoch !== catalog.navigationEpoch.current) return;
          await refreshSessions();
        } catch (cause) {
          if (!request.signal.aborted && epoch === catalog.navigationEpoch.current) setSessionError(sessionId, errorMessage(cause));
        }
      }
    },
    [client, load, failLoad, fetchHistory, markSessionSeen, refreshSessions, reset, setCurrentSessionId, setPage, setSelectedWorkspaceId, catalog.navigationEpoch, setSessionError],
  );

  const forkSession = useCallback(
    async (anchorMessageId: string) => {
      const sourceSessionId = catalog.currentSessionId;
      if (!sourceSessionId) return false;
      try {
        const session = await client.call<Session>("session.fork", {
          sessionId: sourceSessionId,
          anchorMessageId,
        });
        await refreshSessions();
        setSelectedWorkspaceId(session.workspaceId);
        setCurrentSessionId(session.id);
        setPage(null);
        reset(session.id);
        failLoad(session.id);
        await openSession(session.id);
        return true;
      } catch (cause) {
        setSessionError(sourceSessionId, errorMessage(cause));
        return false;
      }
    },
    [catalog.currentSessionId, client, failLoad, openSession, refreshSessions, reset, setCurrentSessionId, setPage, setSelectedWorkspaceId, setSessionError],
  );

  const syncSession = useCallback(async (sessionId: string) => {
    if (!activeRef.current) return;
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
    const cursor = feed.nextCursor;
    if (
      !activeRef.current || feed.loading || !sessionId || !cursor ||
      consumed.current.has(cursorKey(cursor))
    ) return;
    if (paging.current) {
      if (paging.current.sessionId === sessionId && paging.current.epoch === catalog.navigationEpoch.current) {
        paging.current.wanted = true;
        setLoadingOlder(true);
        return await paging.current.promise;
      }
      return;
    }
    const ready = prefetched.current;
    if (
      ready && ready.sessionId === sessionId &&
      ready.epoch === catalog.navigationEpoch.current &&
      cursorKey(ready.cursor) === cursorKey(cursor)
    ) {
      prefetched.current = null;
      consumed.current.add(cursorKey(cursor));
      prepend(sessionId, ready.page);
      return;
    }
    return await fetchHistory(sessionId, cursor);
  }, [catalog.currentSessionId, catalog.navigationEpoch, feed.loading, feed.nextCursor, fetchHistory, prepend]);

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
    forkSession,
    openSession,
    syncSession,
    loadOlder,
    setHistoryPrefetchPinned,
    loadingOlder,
    deleteSession,
    renameSession,
    setSessionPinned,
    setSessionArchived,
  };
}
