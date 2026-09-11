import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL_SETTINGS,
  type SessionModelResult,
  type SessionModelSettings,
} from "../modelSelection";
import type { RpcClient } from "../rpc";
import { useSessionError } from "./useSessionError";

export function useSessionModel(
  client: RpcClient,
  sessionId: string | null,
  workspaceId: string | null = null
) {
  const [result, setResult] = useState<SessionModelResult>({
    settings: DEFAULT_MODEL_SETTINGS,
    effective: null,
  });
  const [ready, setReady] = useState(false);
  const modelContext = sessionId ? `session:${sessionId}` : `workspace:${workspaceId ?? ""}`;
  const [loadedContext, setLoadedContext] = useState<string | undefined>();
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const [pending, setPending] = useState(false);
  const [error, setError] = useSessionError(sessionId ?? "draft");
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
      else if (workspaceId)
        next = await client.call("workspace.modelGet", { workspaceId });
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
      setLoadedContext(modelContext);
      setError(null);
      setReady(true);
    } catch (cause) {
      if (request === generation.current) setError(String(cause));
    }
  }, [client, modelContext, sessionId, setError, workspaceId]);

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
        event.type === "global_model_settings_changed" ||
        (event.type === "model_settings_changed" && event.sessionId === sessionId) ||
        (event.type === "workspace_model_settings_changed" &&
          event.workspaceId === workspaceId)
      )
        void reload();
    });
    return () => {
      generation.current++;
      stopStatus();
      stopEvents();
    };
  }, [client, reload, sessionId, workspaceId]);

  const update = async (settings: SessionModelSettings) => {
    if (updatePending.current) return;
    updatePending.current = true;
    const request = generation.current;
    setPending(true);
    try {
      const method = sessionId
        ? "session.modelUpdate"
        : workspaceId
          ? "workspace.modelUpdate"
          : "model.update";
      const params = sessionId
        ? { sessionId, settings }
        : workspaceId
          ? { workspaceId, settings }
          : { settings };
      const next = await client.call<SessionModelResult>(method, params);
      newSessionSelection.current = settings;
      if (request === generation.current) setResult(next);
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
    ...(loadedContext === modelContext
      ? result
      : { settings: DEFAULT_MODEL_SETTINGS, effective: null }),
    ready: ready && loadedContext === modelContext,
    pending,
    error,
    update,
    reload,
  };
}
