import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import {
  readLocalFilePreview,
  type LocalPreviewKind,
  type LocalFileTarget,
} from "../localFiles";
import {
  EMPTY_PREVIEW_TABS,
  removePreviewTab,
  selectPreviewTab,
  type PreviewTabsState,
} from "../previewTabs";
import { PreviewViewStore } from "../previewViewState";

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

export function useFilePreview(
  workspacePath?: string | null,
  sessionId?: string | null,
  workspacePaths: readonly string[] = NO_PATHS,
) {
  const [state, setState] = useState<FilePreviewState>(EMPTY_PREVIEW);
  const [views] = useState(() => new PreviewViewStore());
  const scope = JSON.stringify([
    sessionId ?? null,
    workspacePath ?? null,
    workspacePaths,
  ]);
  const [stateScope, setStateScope] = useState(scope);
  const [sessions, setSessions] = useState<Record<string, PreviewTabsState>>(
    {},
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const tabs = sessions[scope] ?? EMPTY_PREVIEW_TABS;
  const requestSequence = useRef(0);

  const openFile = useCallback(
    async (target: LocalFileTarget) => {
      const requestId = ++requestSequence.current;
      setStateScope(scope);
      setSessions((current) => ({
        ...current,
        [scope]: selectPreviewTab(current[scope] ?? EMPTY_PREVIEW_TABS, target),
      }));
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
        );
        if (requestId !== requestSequence.current) return;
        setSessions((current) => ({
          ...current,
          [scope]: selectPreviewTab(
            current[scope] ?? EMPTY_PREVIEW_TABS,
            { ...target, path: file.path },
            target.path,
          ),
        }));
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
    [workspacePath, workspacePaths, scope],
  );

  const close = useCallback(() => {
    requestSequence.current += 1;
    setSessions((current) => ({
      ...current,
      [scope]: { ...(current[scope] ?? EMPTY_PREVIEW_TABS), open: false },
    }));
    setState((current) => ({ ...current, open: false, loading: false }));
  }, [scope]);

  const closeTab = useCallback(
    (path: string) => {
      views.closeFile(scope, path);
      const previous = sessionsRef.current[scope] ?? EMPTY_PREVIEW_TABS;
      const next = removePreviewTab(previous, path);
      setSessions((current) => ({ ...current, [scope]: next }));
      if (previous.active !== path) return;
      requestSequence.current++;
      const target = next.targets.find((item) => item.path === next.active);
      if (target) void openFile(target);
      else setState(EMPTY_PREVIEW);
    },
    [scope, openFile, views],
  );

  useEffect(() => {
    requestSequence.current += 1;
    setStateScope(scope);
    setState(EMPTY_PREVIEW);
    const saved = sessionsRef.current[scope];
    const target = saved?.targets.find((item) => item.path === saved.active);
    // Keep only tab identities between sessions; large file payloads are re-read.
    if (saved?.open && target) void openFile(target);
    return () => {
      requestSequence.current++;
    };
  }, [scope, openFile]);

  return {
    views,
    viewScope: scope,
    state: stateScope === scope ? state : EMPTY_PREVIEW,
    tabs: tabs.targets,
    closeTab,
    openFile,
    close,
  };
}
