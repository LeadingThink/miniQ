import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL_SETTINGS,
  type SessionModelResult,
  type SessionModelSettings,
} from "../modelSelection";
import type { RpcClient } from "../rpc";
import { useSessionError } from "./useSessionError";

function draftResult(
  defaults: SessionModelResult,
  settings: SessionModelSettings | undefined,
): SessionModelResult {
  if (!settings) return defaults;
  return {
    settings,
    effective: defaults.effective
      ? {
          model: settings.model ?? defaults.effective.model,
          apiProtocol: settings.model || settings.apiProtocol !== "auto"
            ? settings.apiProtocol : defaults.effective.apiProtocol,
          reasoningEffort: settings.reasoningEffort,
        }
      : null,
  };
}

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
  const currentContext = useRef(modelContext);
  currentContext.current = modelContext;
  const [pending, setPending] = useState(false);
  const [error, setError] = useSessionError(modelContext);
  const drafts = useRef(new Map<string | null, SessionModelSettings>());
  const draftDefaults = useRef<SessionModelResult>(result);
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
        next = {
          settings: DEFAULT_MODEL_SETTINGS,
          effective: defaults.provider
            ? {
                model: defaults.provider.model,
                apiProtocol: defaults.provider.apiProtocol,
                reasoningEffort: null,
              }
            : null,
        };
      }
      if (request !== generation.current) return;
      if (!sessionId) {
        draftDefaults.current = next;
        next = draftResult(next, drafts.current.get(workspaceId));
      }
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
    if (!ready || loadedContext !== modelContext)
      throw new Error("请等待当前会话的模型配置加载完成");
    if (!sessionId) {
      drafts.current.set(workspaceId, settings);
      setResult(draftResult(draftDefaults.current, settings));
      setError(null);
      return;
    }
    updatePending.current = true;
    const request = generation.current;
    setPending(true);
    try {
      const next = await client.call<SessionModelResult>("session.modelUpdate", {
        sessionId, settings,
      });
      if (request === generation.current) setResult(next);
      if (currentContext.current === modelContext) setError(null);
    } catch (cause) {
      if (currentContext.current === modelContext) setError(String(cause));
      throw cause;
    } finally {
      updatePending.current = false;
      setPending(false);
    }
  };
  const selectedDraft = drafts.current.get(workspaceId);
  return {
    ...(loadedContext === modelContext
      ? result
      : { settings: DEFAULT_MODEL_SETTINGS, effective: null }),
    ready: ready && loadedContext === modelContext,
    pending,
    error,
    update,
    reload,
    clearDraft: () => {
      if (drafts.current.get(workspaceId) === selectedDraft)
        drafts.current.delete(workspaceId);
    },
  };
}
