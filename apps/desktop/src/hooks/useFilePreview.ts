import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import {
  readLocalFilePreview,
  type LocalPreviewKind,
  type LocalFileTarget,
} from "../localFiles";
import {
  EMPTY_PREVIEW_TABS,
  closePreviewTabs,
  removePreviewTab,
  reopenPreviewTab,
  selectPreviewTab,
  type PreviewTabsState,
} from "../previewTabs";
import { PreviewViewStore } from "../previewViewState";
import type { RpcClient } from "../rpc";

export interface FilePreviewState {
  target: LocalFileTarget | null;
  resolvedPath: string | null;
  content: string | null;
  kind: LocalPreviewKind | null;
  mimeType: string | null;
  dataBase64: string | null;
  size: number | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  progress?: { received: number; total: number };
}

const EMPTY_PREVIEW: FilePreviewState = {
  target: null,
  resolvedPath: null,
  content: null,
  kind: null,
  mimeType: null,
  dataBase64: null,
  size: null,
  loading: false,
  error: null,
  open: false,
};

const NO_PATHS: readonly string[] = [];
export interface FilePreviewCache {
  sessions: Record<string, PreviewTabsState>;
  views: PreviewViewStore;
}

export function useFilePreview(
  workspacePath?: string | null,
  sessionId?: string | null,
  workspacePaths: readonly string[] = NO_PATHS,
  client?: RpcClient,
  cache?: FilePreviewCache,
) {
  const [state, setState] = useState<FilePreviewState>(EMPTY_PREVIEW);
  const [views] = useState(() => cache?.views ?? new PreviewViewStore());
  const scope = JSON.stringify([
    sessionId ?? null,
    workspacePath ?? null,
    workspacePaths,
  ]);
  const [stateScope, setStateScope] = useState(scope);
  const [sessions, setSessions] = useState<Record<string, PreviewTabsState>>(
    cache?.sessions ?? {},
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const tabs = sessions[scope] ?? EMPTY_PREVIEW_TABS;
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController>();
  const updateTabs = useCallback(
    (update: (current: PreviewTabsState) => PreviewTabsState) => {
      const next = update(sessionsRef.current[scope] ?? EMPTY_PREVIEW_TABS);
      sessionsRef.current = { ...sessionsRef.current, [scope]: next };
      if (cache) cache.sessions = sessionsRef.current;
      setSessions(sessionsRef.current);
      return next;
    },
    [scope, cache],
  );

  const openFile = useCallback(
    async (target: LocalFileTarget) => {
      const requestId = ++requestSequence.current;
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      setStateScope(scope);
      updateTabs((current) => selectPreviewTab(current, target));
      setState({
        target,
        resolvedPath: target.path,
        content: null,
        kind: null,
        mimeType: null,
        dataBase64: null,
        size: null,
        loading: true,
        error: null,
        open: true,
      });
      try {
        const file = await readLocalFilePreview(
          target.path,
          workspacePath,
          workspacePaths,
          {
            client,
            sessionId,
            signal: controller.signal,
            onProgress: (received, total) => {
              if (requestId === requestSequence.current)
                setState((current) => ({
                  ...current,
                  progress: { received, total },
                }));
            },
          },
        );
        if (requestId !== requestSequence.current) return;
        updateTabs((current) =>
          selectPreviewTab(
            current,
            { ...target, path: file.path },
            target.path,
          ),
        );
        setState({
          target: { ...target, path: file.path },
          resolvedPath: file.path,
          content: file.content,
          kind: file.kind,
          mimeType: file.mimeType,
          dataBase64: file.dataBase64,
          size: file.size,
          loading: false,
          error: null,
          open: true,
        });
      } catch (cause) {
        if (requestId !== requestSequence.current) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: errorMessage(cause),
        }));
      }
    },
    [workspacePath, workspacePaths, scope, client, sessionId, updateTabs],
  );

  const close = useCallback(() => {
    requestSequence.current += 1;
    requestController.current?.abort();
    updateTabs((current) => ({ ...current, open: false }));
    // Keep tab identities separately, but release large media payloads as soon
    // as the panel closes, particularly on memory-constrained mobile devices.
    setState(EMPTY_PREVIEW);
  }, [updateTabs]);

  const changeTabs = useCallback(
    (update: (current: PreviewTabsState) => PreviewTabsState) => {
      const previous = sessionsRef.current[scope] ?? EMPTY_PREVIEW_TABS;
      const next = updateTabs(update);
      if (previous.active === next.active && previous.open === next.open)
        return;
      requestSequence.current++;
      requestController.current?.abort();
      const target = next.targets.find((item) => item.path === next.active);
      if (target) void openFile(target);
      else setState(EMPTY_PREVIEW);
    },
    [scope, openFile, updateTabs],
  );

  const closeTab = useCallback(
    (path: string) => {
      changeTabs((current) => removePreviewTab(current, path));
    },
    [changeTabs],
  );

  const closeOtherTabs = useCallback(
    (path: string) => {
      changeTabs((current) =>
        current.targets.some((item) => item.path === path)
          ? closePreviewTabs(
              current,
              new Set(
                current.targets
                  .filter((item) => item.path !== path)
                  .map((item) => item.path),
              ),
            )
          : current,
      );
    },
    [changeTabs],
  );

  const closeAllTabs = useCallback(() => {
    changeTabs((current) =>
      closePreviewTabs(
        current,
        new Set(current.targets.map((item) => item.path)),
      ),
    );
  }, [changeTabs]);

  const reopenClosedTab = useCallback(() => {
    changeTabs(reopenPreviewTab);
  }, [changeTabs]);

  const reopen = useCallback(() => {
    const saved = sessionsRef.current[scope];
    const target = saved?.targets.find((item) => item.path === saved.active);
    if (target) void openFile(target);
    else reopenClosedTab();
  }, [scope, openFile, reopenClosedTab]);

  useEffect(() => {
    requestSequence.current += 1;
    requestController.current?.abort();
    setStateScope(scope);
    setState(EMPTY_PREVIEW);
    const saved = sessionsRef.current[scope];
    const target = saved?.targets.find((item) => item.path === saved.active);
    // Keep only tab identities between sessions; large file payloads are re-read.
    if (saved?.open && target) void openFile(target);
    return () => {
      requestSequence.current++;
      requestController.current?.abort();
    };
  }, [scope, openFile]);

  return {
    views,
    viewScope: scope,
    state: stateScope === scope ? state : EMPTY_PREVIEW,
    tabs: tabs.targets,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    reopenClosedTab,
    canReopenClosedTab: tabs.closed.length > 0,
    reopen,
    openFile,
    close,
  };
}
