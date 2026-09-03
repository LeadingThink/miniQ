import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import {
  readLocalFilePreview,
  type LocalPreviewKind,
  type LocalFileTarget,
} from "../localFiles";

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

export function useFilePreview(workspacePath?: string | null) {
  const [state, setState] = useState<FilePreviewState>(EMPTY_PREVIEW);
  const requestSequence = useRef(0);

  const openFile = useCallback(
    async (target: LocalFileTarget) => {
      const requestId = ++requestSequence.current;
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
        const file = await readLocalFilePreview(target.path, workspacePath);
        if (requestId !== requestSequence.current) return;
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
    [workspacePath],
  );

  const close = useCallback(() => {
    requestSequence.current += 1;
    setState((current) => ({ ...current, open: false, loading: false }));
  }, []);

  useEffect(() => {
    requestSequence.current += 1;
    setState(EMPTY_PREVIEW);
  }, [workspacePath]);

  return { state, openFile, close };
}
