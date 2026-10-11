import { isTauriRuntime } from "./runtime";

/** Native browser events emitted by `src-tauri/src/browser.rs` (see docs/embedded-browser-contract.md). */
export interface BrowserLoadError { code: string; message: string }
export interface BrowserPageLoadEvent {
  viewId: string;
  url: string;
  phase: "started" | "finished" | "failed";
  error?: BrowserLoadError;
}
export interface BrowserTitleEvent { viewId: string; title: string }
export interface BrowserNewWindowEvent { viewId: string; url: string }
export interface BrowserDownloadEvent {
  viewId: string;
  id: string;
  url: string;
  fileName: string;
  path: string;
  phase: "started" | "finished" | "failed";
}
export interface BrowserExternalEvent { viewId: string; url: string }

export interface BrowserEventMap {
  "browser://page-load": BrowserPageLoadEvent;
  "browser://title": BrowserTitleEvent;
  "browser://new-window": BrowserNewWindowEvent;
  "browser://download": BrowserDownloadEvent;
  "browser://external": BrowserExternalEvent;
}

type Listen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;

let listenModule: Promise<Listen> | undefined;
function loadListen(): Promise<Listen> {
  listenModule ??= import("@tauri-apps/api/event").then((module) => module.listen as Listen);
  listenModule.catch(() => { listenModule = undefined; });
  return listenModule;
}

/**
 * Subscribes to one native browser event for a single view. Outside Tauri
 * (tests, web preview) it is a no-op. Returns a synchronous disposer that also
 * covers a subscription still being established.
 */
export function listenBrowserEvent<K extends keyof BrowserEventMap>(
  name: K,
  viewId: string,
  handler: (payload: BrowserEventMap[K]) => void,
): () => void {
  if (!isTauriRuntime()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void loadListen()
    .then((listen) => listen(name, (event) => {
      const payload = event.payload as BrowserEventMap[K] | null;
      if (disposed || !payload || typeof payload !== "object" || payload.viewId !== viewId) return;
      handler(payload);
    }))
    .then((off) => { if (disposed) off(); else unlisten = off; })
    .catch(() => undefined);
  return () => { disposed = true; unlisten?.(); };
}
