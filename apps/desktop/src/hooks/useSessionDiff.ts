import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import type { SessionDiff, ToolCall } from "../types";
import { FILE_WRITE_TOOLS, fetchTurnDiff } from "../turnChanges";

const EMPTY_DIFF: SessionDiff = { files: [], additions: 0, deletions: 0 };

/** Which changes the review panel shows: the whole session or one turn. */
export type ReviewScope = "session" | "turn";

export interface ReviewFocus {
  path: string;
  nonce: number;
}

function writeRevision(toolCalls: ToolCall[]): string {
  return toolCalls
    .filter((call) => FILE_WRITE_TOOLS.has(call.toolName))
    .map((call) => `${call.id}:${call.status}`)
    .join("|");
}

/** Session-wide diff (toolbar counts) plus the scope shown in the review panel.
 * `latestTurnId` is the newest user message; the turn scope falls back to it. */
export function useSessionDiff(
  client: RpcClient,
  sessionId: string | null,
  toolCalls: ToolCall[],
  latestTurnId?: string | null,
) {
  const [data, setData] = useState<SessionDiff>(EMPTY_DIFF);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<ReviewScope>("session");
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [focus, setFocus] = useState<ReviewFocus | null>(null);
  const [turnData, setTurnData] = useState<SessionDiff>(EMPTY_DIFF);
  const [turnError, setTurnError] = useState<string | null>(null);
  // Bumped whenever files are restored outside a tool call, so per-turn
  // change cards refetch.
  const [epoch, setEpoch] = useState(0);
  const requestSequence = useRef(0);
  const turnSequence = useRef(0);
  const revision = useMemo(() => writeRevision(toolCalls), [toolCalls]);
  const turnId = selectedTurnId ?? latestTurnId ?? null;

  const refreshSession = useCallback(async () => {
    const requestId = ++requestSequence.current;
    if (!sessionId) {
      setData(EMPTY_DIFF);
      setOpen(false);
      setError(null);
      return;
    }
    try {
      const result = await client.call<SessionDiff>("session.diff", { sessionId });
      if (requestId !== requestSequence.current) return;
      setData(result);
      setError(null);
      if (result.files.length === 0) setOpen(false);
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setError(errorMessage(cause));
    }
  }, [client, sessionId]);

  const refreshTurn = useCallback(async () => {
    const requestId = ++turnSequence.current;
    if (!sessionId || scope !== "turn" || !turnId) {
      setTurnData(EMPTY_DIFF);
      setTurnError(null);
      return;
    }
    try {
      const result = await fetchTurnDiff(client, sessionId, turnId);
      if (requestId !== turnSequence.current) return;
      setTurnData(result);
      setTurnError(null);
    } catch (cause) {
      if (requestId !== turnSequence.current) return;
      setTurnError(errorMessage(cause));
    }
  }, [client, sessionId, scope, turnId]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshSession(), refreshTurn()]);
  }, [refreshSession, refreshTurn]);

  useEffect(() => {
    requestSequence.current += 1;
    turnSequence.current += 1;
    setData(EMPTY_DIFF);
    setOpen(false);
    setError(null);
    setScope("session");
    setSelectedTurnId(null);
    setFocus(null);
  }, [client, sessionId]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession, revision, epoch]);

  useEffect(() => {
    void refreshTurn();
  }, [refreshTurn, revision, epoch]);

  /** Toolbar entry: show every change in the session. */
  const showSession = useCallback(() => {
    setScope("session");
    setSelectedTurnId(null);
    setFocus(null);
  }, []);

  /** Change-card entry: show one turn, optionally focused on a file. */
  const showTurn = useCallback((id: string, path?: string) => {
    setScope("turn");
    setSelectedTurnId(id);
    setFocus(path ? { path, nonce: Date.now() } : null);
  }, []);

  /** Files were restored (checkpoint or turn rollback): refetch everything. */
  const filesRestored = useCallback(() => setEpoch((value) => value + 1), []);

  const turnScoped = scope === "turn";
  return {
    data,
    error,
    open: open && data.files.length > 0,
    setOpen,
    refresh,
    scope,
    setScope,
    focus,
    epoch,
    showSession,
    showTurn,
    filesRestored,
    /** Diff and error for the scope the review panel shows. */
    view: {
      diff: turnScoped ? turnData : data,
      error: turnScoped ? turnError : error,
    },
  };
}
