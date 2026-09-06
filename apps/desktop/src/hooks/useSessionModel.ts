import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL_SETTINGS,
  type SessionModelResult,
  type SessionModelSettings,
} from "../modelSelection";
import type { RpcClient } from "../rpc";

export function useSessionModel(client: RpcClient, sessionId: string | null) {
  const [result, setResult] = useState<SessionModelResult>({
    settings: DEFAULT_MODEL_SETTINGS,
    effective: null,
  });
  const [ready, setReady] = useState(false);
  const [loadedSession, setLoadedSession] = useState<string | null | undefined>(
    undefined
  );
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newSessionSelection = useRef(DEFAULT_MODEL_SETTINGS);
  const generation = useRef(0);
  const updatePending = useRef(false);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    setReady(false);
    try {
      let next: SessionModelResult;
      if (sessionId)
        next = await client.call("session.modelGet", { sessionId });
      else {
        const defaults = await client.call<{
          provider: SessionModelResult["effective"];
        }>("settings.get");
        const selection = newSessionSelection.current;
        next = {
          settings: selection,
          effective: defaults.provider
            ? {
                model: selection.model ?? defaults.provider.model,
                apiProtocol:
                  selection.model || selection.apiProtocol !== "auto"
                    ? selection.apiProtocol
                    : defaults.provider.apiProtocol,
                reasoningEffort: selection.reasoningEffort,
              }
            : null,
        };
      }
      if (request !== generation.current) return;
      setResult(next);
      setLoadedSession(sessionId);
      setError(null);
      setReady(true);
    } catch (cause) {
      if (request === generation.current) setError(String(cause));
    }
  }, [client, sessionId]);

  useEffect(() => {
    if (client.connected) void reload();
    const stopStatus = client.onStatus((connected) => {
      if (connected) void reload();
      else {
        generation.current++;
        setReady(false);
      }
    });
    const stopEvents = client.onEvent((event) => {
      if (
        event.type === "model_settings_changed" &&
        event.sessionId === sessionId
      )
        void reload();
    });
    return () => {
      generation.current++;
      stopStatus();
      stopEvents();
    };
  }, [client, reload, sessionId]);

  const update = async (settings: SessionModelSettings) => {
    if (updatePending.current) return;
    updatePending.current = true;
    const request = generation.current;
    setPending(true);
    try {
      if (sessionId) {
        const next = await client.call<SessionModelResult>(
          "session.modelUpdate",
          { sessionId, settings }
        );
        if (request === generation.current) setResult(next);
      } else {
        newSessionSelection.current = settings;
        await reload();
      }
      if (currentSession.current === sessionId) setError(null);
    } catch (cause) {
      if (currentSession.current === sessionId) setError(String(cause));
      throw cause;
    } finally {
      updatePending.current = false;
      setPending(false);
    }
  };
  return {
    ...result,
    ready: ready && loadedSession === sessionId,
    pending,
    error,
    update,
    reload,
  };
}
