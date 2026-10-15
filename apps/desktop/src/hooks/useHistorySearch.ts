import { useCallback, useEffect, useRef, useState } from "react";
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
  const pending = useRef<AbortController | null>(null);
  const latest = useRef({ key, client, enabled });
  latest.current = { key, client, enabled };

  const fetchPage = useCallback(async (before: HistoryPage["nextCursor"], request: AbortController) => {
    if (!client || !sessionId) return;
    const current = () => !request.signal.aborted && latest.current.key === key && latest.current.client === client && latest.current.enabled;
    try {
      const page = await client.call<HistoryPage>("session.history", {
        sessionId, filter, query: query.trim(), before,
      }, { signal: request.signal });
      if (!current()) return;
      setResult((previous) => ({ key, page: before && previous?.key === key ? {
        messages: [...page.messages, ...previous.page.messages],
        toolCalls: [...page.toolCalls, ...previous.page.toolCalls],
        nextCursor: page.nextCursor,
      } : page }));
      setError(null);
    } catch (cause) {
      if (current()) {
        // Pagination errors belong to the scroll hook's bounded retry cycle.
        if (!before) setError(errorMessage(cause));
        return { error: cause };
      }
    } finally {
      if (pending.current === request) pending.current = null;
      if (current()) setLoading(false);
    }
  }, [client, sessionId, key, filter, query]);

  useEffect(() => {
    setError(null);
    if (!enabled) { setLoading(false); return; }
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    const timer = window.setTimeout(() => { void fetchPage(null, request); }, query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [enabled, fetchPage, revision]);

  const loadOlder = useCallback(() => {
    if (pending.current || result?.key !== key || !result.page.nextCursor) return;
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    return fetchPage(result.page.nextCursor, request);
  }, [result, key, fetchPage]);

  return {
    enabled,
    page: result?.key === key ? result.page : null,
    loading: enabled && (loading || (!error && result?.key !== key)),
    error: enabled ? error : null,
    loadOlder,
    retry: useCallback(() => setRevision((value) => value + 1), []),
  };
}
