import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import type { ContextUsage } from "../contextUsage";

export function useContextUsage(client: RpcClient, sessionId: string | null) {
  const [state, setState] = useState<{
    client: RpcClient; sessionId: string | null;
    usage: ContextUsage | null; loading: boolean; error: string | null;
  }>({ client, sessionId, usage: null, loading: false, error: null });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const request = ++generation.current;
    if (!sessionId || !client.connected) {
      setState({ client, sessionId, usage: null, loading: false,
        error: sessionId ? "连接已断开" : null });
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setState(previous => ({ client, sessionId,
      usage: previous.client === client && previous.sessionId === sessionId ? previous.usage : null,
      loading: true, error: null }));
    try {
      const usage = await client.call<ContextUsage>("session.contextUsage", { sessionId }, { signal: abort.signal });
      if (request === generation.current) setState({ client, sessionId, usage, loading: false, error: null });
    } catch (cause) {
      if (request === generation.current) setState({ client, sessionId, usage: null,
        loading: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [client, sessionId]);

  useEffect(() => {
    void refresh();
    let eventRefresh: ReturnType<typeof setTimeout> | undefined;
    const stopStatus = client.onStatus(connected => {
      if (connected) void refresh();
      else {
        generation.current++;
        controller.current?.abort();
        setState({ client, sessionId, usage: null, loading: false, error: "连接已断开" });
      }
    });
    const stopResync = client.onResync(() => { void refresh(); });
    const stopEvents = client.onEvent(event => {
      if (event.type === "global_model_settings_changed" || event.type === "workspace_model_settings_changed" ||
        ("sessionId" in event && event.sessionId === sessionId && [
          "turn_completed", "turn_failed", "context_compacted", "message_created", "model_settings_changed",
          "session_rewritten", "session_restored",
        ].includes(event.type))) {
        if (eventRefresh !== undefined) clearTimeout(eventRefresh);
        eventRefresh = setTimeout(() => { eventRefresh = undefined; void refresh(); }, 150);
      }
    });
    return () => {
      generation.current++;
      controller.current?.abort();
      if (eventRefresh !== undefined) clearTimeout(eventRefresh);
      stopStatus(); stopResync(); stopEvents();
    };
  }, [client, refresh, sessionId]);

  const current = state.client === client && state.sessionId === sessionId;
  return { usage: current ? state.usage : null, loading: current ? state.loading : false,
    error: current ? state.error : null, refresh };
}