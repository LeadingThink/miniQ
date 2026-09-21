import { useEffect } from "react";
import { isTauriRuntime } from "../runtime";

/** Listen for native file drops (Tauri window-level drag & drop). */
export function useDroppedFiles(
  onFiles: (paths: string[]) => void,
  onError?: (message: string) => void,
) {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWebviewWindow } =
        await import("@tauri-apps/api/webviewWindow");
      const stop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          onFiles(event.payload.paths);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })().catch((error) => {
      onError?.(
        `无法接收拖入文件: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onError, onFiles]);
}
