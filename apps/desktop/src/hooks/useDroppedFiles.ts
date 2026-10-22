import { useEffect, useRef, type RefObject } from "react";
import { pickComposerTarget } from "../composerTarget";
import { isTauriRuntime } from "../runtime";

type Target = {
  input: RefObject<HTMLElement | null>;
  receive: RefObject<(paths: string[]) => void>;
  fail: RefObject<((message: string) => void) | undefined>;
};

// Native drops arrive as one window-level event. A single subscription lives
// for the app lifetime and routes each drop to exactly one visible composer,
// so re-renders never open a gap where a drop is lost, and hidden composers
// (background hosts, other views) never receive the same files.
const targets: Target[] = [];
let subscription: Promise<unknown> | null = null;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Browser image drags carry pixels instead of paths; the native side saves them.
async function route(paths: string[]) {
  const target = pickComposerTarget(targets);
  if (!target) return;
  if (paths.length > 0) {
    target.receive.current(paths);
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const saved = await invoke<string | null>("save_dragged_image");
    if (saved) target.receive.current([saved]);
  } catch (error) {
    target.fail.current?.(`无法接收拖入图片: ${reason(error)}`);
  }
}

function subscribe(onError: (message: string) => void) {
  if (subscription) return;
  subscription = (async () => {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") void route(event.payload.paths);
    });
  })().catch((error) => {
    subscription = null;
    onError(`无法接收拖入文件: ${reason(error)}`);
  });
}

/** Routes native file drops (Tauri window-level drag & drop) to this composer while it is the active one. */
export function useDroppedFiles(
  input: RefObject<HTMLElement | null>,
  onFiles: (paths: string[]) => void,
  onError?: (message: string) => void,
) {
  const receive = useRef(onFiles);
  receive.current = onFiles;
  const fail = useRef(onError);
  fail.current = onError;
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const target: Target = { input, receive, fail };
    targets.push(target);
    subscribe((message) => fail.current?.(message));
    return () => { targets.splice(targets.indexOf(target), 1); };
  }, [input]);
}
