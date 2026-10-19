import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { processKey, type ProcessLoad, type ProcessLoadResult } from "../processRecords";
import type { RpcClient } from "../rpc";
import type { HistoryPage } from "../types";

interface Pending {
  controller: AbortController;
  promise: Promise<ProcessLoadResult>;
}

/**
 * Loads the folded records of one turn at a time, a bounded page per call,
 * newest first. Calls for a turn already in flight share that request, and a
 * complete turn is never fetched again. Failures resolve to `{ error }` so the
 * fold that asked can show them and retry.
 */
export function useProcessLoader(
  client: RpcClient,
  sessionId: string | null,
  epoch: MutableRefObject<number>,
  feed: {
    loading: boolean;
    processLoads: Record<string, ProcessLoad>;
    mergeProcess: (sessionId: string, key: string, page: HistoryPage) => void;
  },
) {
  const { loading, processLoads, mergeProcess } = feed;
  const loads = useRef(processLoads);
  loads.current = processLoads;
  const pending = useRef(new Map<string, Pending>());
  const abortAll = useCallback(() => {
    for (const request of pending.current.values()) request.controller.abort();
    pending.current.clear();
  }, []);
  // A reload replaces the conversation: pages requested for the old one are stale.
  useEffect(() => { if (loading) abortAll(); }, [loading, abortAll]);
  useEffect(() => abortAll, [client, sessionId, abortAll]);

  return useCallback((turnId: string | null): Promise<ProcessLoadResult> => {
    const key = processKey(turnId);
    const inFlight = pending.current.get(key);
    if (inFlight) return inFlight.promise;
    const current = loads.current[key];
    if (!sessionId || current?.complete) return Promise.resolve();
    const controller = new AbortController();
    const started = epoch.current;
    // Register before running: a synchronous failure must clear its own entry.
    const request: Pending = { controller, promise: Promise.resolve() };
    pending.current.set(key, request);
    request.promise = (async (): Promise<ProcessLoadResult> => {
      try {
        const page = await client.call<HistoryPage>("session.processRecords", {
          sessionId,
          ...(turnId ? { turnId } : {}),
          ...(current?.cursor ? { before: current.cursor } : {}),
        }, { signal: controller.signal });
        if (!controller.signal.aborted && started === epoch.current) mergeProcess(sessionId, key, page);
      } catch (cause) {
        if (!controller.signal.aborted) return { error: cause };
      } finally {
        if (pending.current.get(key) === request) pending.current.delete(key);
      }
    })();
    return request.promise;
  }, [client, sessionId, epoch, mergeProcess]);
}
