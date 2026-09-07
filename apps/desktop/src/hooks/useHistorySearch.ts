import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import type { HistoryPage } from "../types";
import type { TimelineFilter } from "../timelineModel";
import { errorMessage } from "../errorMessage";

export function useHistorySearch(client: RpcClient | undefined, sessionId: string | undefined, filter: TimelineFilter, query: string) {
  const enabled = Boolean(client && sessionId && (filter !== "all" || query.trim()));
  const key = JSON.stringify([sessionId, filter, query.trim()]);
  const [result, setResult] = useState<{ key: string; page: HistoryPage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [before, setBefore] = useState<HistoryPage["nextCursor"]>(null);
  useEffect(() => { setBefore(null); setError(null); }, [key]);
  useEffect(() => {
    if (!enabled || !client || !sessionId) return;
    const request = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      void client.call<HistoryPage>("session.history", { sessionId, filter, query: query.trim(), before }, { signal: request.signal })
        .then((page) => {
          if (request.signal.aborted) return;
          setResult((current) => ({ key, page: before && current?.key === key ? {
            messages: [...page.messages, ...current.page.messages],
            toolCalls: [...page.toolCalls, ...current.page.toolCalls],
            nextCursor: page.nextCursor,
          } : page }));
          setError(null);
        })
        .catch((cause) => { if (!request.signal.aborted) setError(errorMessage(cause)); })
        .finally(() => { if (!request.signal.aborted) setLoading(false); });
    }, query ? 250 : 0);
    return () => { window.clearTimeout(timer); request.abort(); };
  }, [enabled, client, sessionId, key, filter, query, before, revision]);
  return {
    enabled,
    page: result?.key === key ? result.page : null,
    loading: enabled && (loading || (!error && result?.key !== key)),
    error: enabled ? error : null,
    loadOlder: () => { if (!loading && result?.key === key) setBefore(result.page.nextCursor); },
    retry: useCallback(() => setRevision((value) => value + 1), []),
  };
}
