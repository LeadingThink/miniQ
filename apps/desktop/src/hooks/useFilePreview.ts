import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import {
  readLocalTextFile,
  type LocalFileTarget,
} from "../localFiles";

export interface FilePreviewState {
  target: LocalFileTarget | null;
  resolvedPath: string | null;
  content: string | null;
  loading: boolean;
  error: string | null;
  open: boolean;
}

const EMPTY_PREVIEW: FilePreviewState = {
  target: null,
  resolvedPath: null,
  content: null,
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
        loading: true,
        error: null,
        open: true,
      });
      try {
        const file = await readLocalTextFile(target.path, workspacePath);
        if (requestId !== requestSequence.current) return;
        setState({
          target: { ...target, path: file.path },
          resolvedPath: file.path,
          content: file.content,
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
