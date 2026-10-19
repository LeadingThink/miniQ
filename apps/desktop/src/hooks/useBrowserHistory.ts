import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import type { HistoryCursor, HistoryPage, ToolCall } from "../types";

const BROWSER_TOOL = "browser_automation";
const PAGE_SIZE = 20;
const NO_CALLS: readonly ToolCall[] = [];

/**
 * Browser observations of one session, newest first, a page at a time. The
 * conversation view no longer loads tool calls outside opened folds, so the
 * record list reads them itself and merges the live ones the feed holds.
 */
export function useBrowserHistory(
  client: RpcClient,
  sessionId: string | null,
  enabled: boolean,
  onError: (message: string) => void,
  live: readonly ToolCall[] = NO_CALLS,
) {
  // `cursor` is undefined until the first page arrives and null once exhausted.
  const [fetched, setFetched] = useState<{ sessionId: string; calls: ToolCall[]; cursor: HistoryCursor | null | undefined } | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  // The first page is requested once per session; a failure waits for the reader.
  const requested = useRef<string | null>(null);
  const current = fetched?.sessionId === sessionId ? fetched : null;
  const cursor = current?.cursor;

  const fetchPage = useCallback(async (before: HistoryCursor | undefined) => {
    if (!sessionId || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const page = await client.call<HistoryPage>("session.history", {
        sessionId, filter: "activity", toolName: BROWSER_TOOL, limit: PAGE_SIZE, ...(before ? { before } : {}),
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setFetched((previous) => ({
        sessionId,
        calls: [...(previous?.sessionId === sessionId ? previous.calls : []), ...page.toolCalls],
        cursor: page.nextCursor,
      }));
    } catch (cause) {
      if (!controller.signal.aborted) onError(`加载网页记录失败: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [client, sessionId, onError]);

  useEffect(() => {
    if (!enabled || !sessionId || current || requested.current === sessionId) return;
    requested.current = sessionId;
    void fetchPage(undefined);
  }, [enabled, sessionId, current, fetchPage]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [client, sessionId]);

  const calls = useMemo(() => {
    const records = new Map((current?.calls ?? []).map((call) => [call.id, call]));
    for (const call of live) records.set(call.id, call);
    return [...records.values()];
  }, [current, live]);
  const loadOlder = useCallback(() => {
    if (cursor !== null) void fetchPage(cursor);
  }, [cursor, fetchPage]);
  return {
    calls,
    // Until the first page arrives there may be records, and it is loading.
    hasOlder: cursor !== null,
    loadingOlder: loading || (enabled && !current),
    loadOlder,
  };
}
