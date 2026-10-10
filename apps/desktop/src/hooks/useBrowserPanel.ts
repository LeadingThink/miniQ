import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  browserAction,
  browserCapabilities,
  closeBrowser,
  currentBrowser,
  evaluateBrowser,
  openBrowser,
  resizeBrowser,
  setBrowserVisible,
  shouldSyncBrowserAddress,
  type BrowserCommandAction,
  type BrowserNavigationAction,
} from "../browserWorkbench";
import { listenBrowserEvent } from "../browserEvents";
import {
  buildBrowserAutomationScript,
  parseBrowserScriptResult,
  type BrowserScriptResult,
} from "../browserAutomationScript";
import { registerEmbeddedBrowser } from "../embeddedBrowserDriver";
import { captureBrowserObservation } from "../browserVisualObservation";
import { waitForBrowserObservation, type BrowserNavigationExpectation } from "../browserObservationWait";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import { useOpenDialog } from "./useOpenDialog";

/** Without a page-load event the navigation is treated as a no-op (e.g. back at history start). */
export const PAGE_LOAD_GRACE_MS = 3000;
/** Upper bound for the loading indicator if a finished event never arrives. */
export const PAGE_LOAD_SAFETY_MS = 30000;

export function useBrowserPanel(
  url: string,
  surface: RefObject<HTMLDivElement | null>,
  requestedSuspension = false,
  requestedViewId?: string,
  requestedBrowserSessionId?: string,
  /** Load `url` on mount even for an agent-owned tab (e.g. a page popup). */
  autoLoad = false,
) {
  const dialogOpen = useOpenDialog();
  const suspended = requestedSuspension || dialogOpen;
  const [viewId] = useState(() => requestedViewId ?? crypto.randomUUID());
  const [address, setAddress] = useState(url);
  const [activeUrl, setActiveUrl] = useState(url);
  const active = useRef(url);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [zoom, setZoom] = useState(1);
  const pageLoading = useRef(false);
  const pageLoadEvents = useRef(0);
  const graceTimer = useRef<number | undefined>(undefined);
  const editing = useRef(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const opened = useRef(false);
  const pendingLoad = useRef<Promise<void> | null>(null);
  const pendingNavigation = useRef<BrowserNavigationExpectation | undefined>(undefined);
  const lastObservation = useRef<BrowserScriptResult | undefined>(undefined);
  const initialUrl = useRef(url);
  const initialLoadStarted = useRef(false);
  const surfaceSequence = useRef(0);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const rememberObservation = useCallback((result: BrowserScriptResult) => {
    if (result.readyState !== "loading" && /^https?:\/\//i.test(result.url)) lastObservation.current = result;
    return result;
  }, []);
  const accept = useCallback((next: string) => {
    const previous = active.current;
    if (lastObservation.current?.url !== next) lastObservation.current = undefined;
    active.current = next;
    setActiveUrl(next);
    setAddress((value) =>
      shouldSyncBrowserAddress(editing.current, value, previous) ? next : value,
    );
  }, []);
  // The IPC call returns once a navigation is dispatched. Loading then follows
  // browser://page-load; if no page load starts, the dispatch was a no-op.
  const settleLoading = useCallback((eventsBefore: number) => {
    window.clearTimeout(graceTimer.current);
    if (pageLoading.current) return;
    if (pageLoadEvents.current !== eventsBefore) {
      setLoading(false);
      return;
    }
    graceTimer.current = window.setTimeout(() => {
      if (mounted.current && !pageLoading.current && pageLoadEvents.current === eventsBefore) setLoading(false);
    }, PAGE_LOAD_GRACE_MS);
  }, []);
  const reconcileSurface = useCallback(async () => {
    const request = ++surfaceSequence.current;
    const rect = surface.current?.getBoundingClientRect();
    if (!mounted.current || suspendedRef.current || !rect || rect.width <= 0 || rect.height <= 0) {
      await setBrowserVisible(viewId, false);
      return;
    }
    // A panel may have moved or become visible since its page was opened in
    // the background. Move the native child before exposing it to the user.
    await resizeBrowser({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewId);
    if (request !== surfaceSequence.current) return;
    await setBrowserVisible(viewId, mounted.current && !suspendedRef.current);
  }, [surface, viewId]);
  const load = useCallback(
    (target: string) => {
      const previousLoad = pendingLoad.current;
      const operation = (async () => {
        // A requested navigation must not silently succeed without dispatch.
        // Serialize address-bar/agent requests against any pending native open.
        if (previousLoad) await previousLoad.catch(() => {});
        const element = surface.current;
        if (!element || !mounted.current) throw new Error("浏览器面板已关闭");
        if (inFlight.current) throw new Error("浏览器正在执行另一个操作，请稍后重试导航");
        const request = ++sequence.current;
        const eventsBefore = pageLoadEvents.current;
        let dispatched = false;
        inFlight.current = true;
        setPending(true);
        setLoading(true);
        setError(null);
        setAddress(target);
        try {
          const navigation: BrowserNavigationExpectation = { url: target };
          if (opened.current && isTauriRuntime()) {
            try {
              navigation.previous = rememberObservation(parseBrowserScriptResult(
                await evaluateBrowser(viewId, buildBrowserAutomationScript("snapshot", {}, viewId)),
              ));
            } catch {
              // A provisional navigation can destroy the old JS context.
              // Reading it must not prevent the user's explicit retry.
              navigation.previous = lastObservation.current;
              if (!navigation.previous) {
                const state = await currentBrowser(viewId).catch(() => null);
                if (state) navigation.previous = { url: state.url };
                else navigation.previousUnavailable = true;
              }
            }
          }
          pendingNavigation.current = navigation;
          const rect = element.getBoundingClientRect();
          const state = await openBrowser(
            target,
            { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            viewId,
            false,
          );
          opened.current = true;
          if (!mounted.current) {
            await closeBrowser(viewId);
            return;
          }
          if (request !== sequence.current) return;
          await reconcileSurface();
          if (!mounted.current || request !== sequence.current) return;
          accept(state.url);
          setAddress(state.url);
          setRevision((value) => value + 1);
          dispatched = true;
        } catch (cause) {
          pendingNavigation.current = undefined;
          if (mounted.current && request === sequence.current) {
            setError(errorMessage(cause));
            setLoading(false);
          }
          throw cause;
        } finally {
          if (mounted.current && request === sequence.current) {
            inFlight.current = false;
            setPending(false);
            if (isTauriRuntime()) {
              if (dispatched) settleLoading(eventsBefore);
              else setLoading(false);
            }
          }
        }
      })();
      pendingLoad.current = operation;
      void operation.finally(() => {
        if (pendingLoad.current === operation) pendingLoad.current = null;
      }).catch(() => {});
      return operation;
    },
    [surface, viewId, accept, reconcileSurface, rememberObservation, settleLoading],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
      inFlight.current = false;
      initialLoadStarted.current = false;
      window.clearTimeout(graceTimer.current);
      // StrictMode's immediate effect remount still owns this same view. Real
      // disposal closes it after that ownership check, including late opens.
      queueMicrotask(() => {
        if (!mounted.current) void closeBrowser(viewId).catch(() => {});
      });
    };
  }, [viewId]);
  useEffect(() => {
    return registerEmbeddedBrowser(viewId, {
      capabilities: browserCapabilities,
      execute: async (operation, arguments_) => {
        if (operation !== "stop" && pendingLoad.current) await pendingLoad.current;
        const observe = async (snapshotArguments = arguments_) => rememberObservation(parseBrowserScriptResult(await evaluateBrowser(
          viewId,
          buildBrowserAutomationScript("snapshot", snapshotArguments, viewId),
        )));
        const freshSnapshotArguments = () => ({
          nextObservationId: arguments_.nextObservationId,
          offset: arguments_.offset,
          limit: arguments_.limit,
        });
        const observeAfterMutation = () => waitForBrowserObservation(() => observe(freshSnapshotArguments()));
        const observeNavigation = async () => {
          const navigation = pendingNavigation.current;
          try {
            return await waitForBrowserObservation(() => observe(freshSnapshotArguments()), navigation);
          } finally {
            if (pendingNavigation.current === navigation) pendingNavigation.current = undefined;
          }
        };
        // A user may hand an already-visible tab to the agent while its first
        // native page is still connecting. Share that navigation's readiness
        // check rather than observing an empty/old document during adoption.
        if (pendingNavigation.current && !["open", "navigate", "close", "stop"].includes(operation)) {
          await observeNavigation();
        }
        const execute = async () => {
          if (operation === "close") {
            await closeBrowser(viewId);
            return { closed: true };
          }
          if (operation === "open" || operation === "navigate") {
            const target = arguments_.url;
            if (typeof target !== "string") throw new Error("浏览器导航缺少 URL");
            await load(target);
            return observeNavigation();
          }
          if (operation === "status" || operation === "wait") {
            if (operation === "wait") {
              const milliseconds = Number(arguments_.milliseconds ?? 250);
              await new Promise((resolve) => window.setTimeout(resolve, milliseconds));
            }
            return observe();
          }
          if (operation === "currentUrl") {
            return observe();
          }
          if (operation === "back" || operation === "forward" || operation === "reload") {
            // Validate the caller's document/tab/viewport before changing
            // history; a fresh snapshot alone would discard that protection.
            const previous = await observe(arguments_);
            await browserAction(operation, viewId);
            const result = await waitForBrowserObservation(() => observe(freshSnapshotArguments()), { previous });
            accept(result.url);
            return result;
          }
          if (operation === "stop") {
            await browserAction("stop", viewId);
            pendingNavigation.current = undefined;
            return observe();
          }
          if (operation === "setVisible") {
            if (typeof arguments_.visible !== "boolean")
              throw new Error("setVisible 缺少 visible 参数");
            // AppShell changes the owning tab's UI visibility. The normal
            // lifecycle reconciles native bounds/visibility, so an automation
            // request cannot paint over another session or an open dialog.
            return observe();
          }
          if (operation === "resize") {
            const width = Number(arguments_.width);
            const height = Number(arguments_.height);
            if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1)
              throw new Error("resize 需要大于等于 1 的有限 width 和 height");
            const rect = surface.current?.getBoundingClientRect();
            await resizeBrowser(
              { x: rect?.x ?? 0, y: rect?.y ?? 0, width, height },
              viewId,
            );
            return observe();
          }
          if ([
            "snapshot",
            "click",
            "doubleClick",
            "move",
            "drag",
            "type",
            "press",
            "scroll",
            "select",
          ].includes(operation)) {
            const raw = await evaluateBrowser(
              viewId,
              buildBrowserAutomationScript(operation, arguments_, viewId),
            );
            const result = rememberObservation(parseBrowserScriptResult(raw));
            if (["click", "doubleClick", "drag", "select", "type", "press"].includes(operation)) {
              return observeAfterMutation();
            }
            return result;
          }
          throw new Error(`此平台的内嵌浏览器不支持 ${operation}`);
        };
        if (operation === "screenshot") {
          return captureBrowserObservation(viewId, () => observe(freshSnapshotArguments()));
        }
        const result = await execute();
        if (operation !== "close" && arguments_.includeScreenshot === true) {
          return captureBrowserObservation(viewId, () => observe(freshSnapshotArguments()));
        }
        return result;
      },
    });
  }, [load, rememberObservation, requestedBrowserSessionId, surface, viewId]);
  useEffect(() => {
    if ((requestedBrowserSessionId && !autoLoad) || initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void load(initialUrl.current).catch(() => {});
  }, [load, requestedBrowserSessionId, autoLoad]);

  useEffect(() => listenBrowserEvent("browser://page-load", viewId, (event) => {
    if (!mounted.current) return;
    pageLoadEvents.current++;
    pageLoading.current = event.phase === "started";
    // An explicit navigation in flight settles the indicator itself once its
    // IPC returns, so a late event from the previous page cannot clear it.
    if (inFlight.current) return;
    window.clearTimeout(graceTimer.current);
    setLoading(event.phase === "started");
    if (event.phase === "finished" && /^https?:\/\//i.test(event.url)) accept(event.url);
  }), [viewId, accept]);

  useEffect(() => {
    if (!loading || !isTauriRuntime()) return;
    const timer = window.setTimeout(() => {
      pageLoading.current = false;
      setLoading(false);
    }, PAGE_LOAD_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    let disposed = false;
    const resize = () => {
      // ResizeObserver already batches layout. A second animation frame can
      // stop in a hidden WebKit view, leaving its native child at stale bounds.
      void reconcileSurface().catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [surface, reconcileSurface, suspended]);

  useEffect(() => {
    if (!isTauriRuntime() || suspended) return;
    let disposed = false;
    let polling = false;
    const refresh = async () => {
      if (
        disposed ||
        polling ||
        inFlight.current ||
        document.visibilityState === "hidden"
      )
        return;
      polling = true;
      const request = sequence.current;
      try {
        const state = await currentBrowser(viewId);
        if (!disposed && request === sequence.current && state)
          accept(state.url);
      } catch (cause) {
        if (!disposed && request === sequence.current)
          setError(`无法同步浏览器状态：${errorMessage(cause)}`);
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 1500);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [viewId, accept, suspended]);

  const action = async (command: BrowserNavigationAction) => {
    // Stopping is deliberately allowed while another navigation is in flight;
    // otherwise the toolbar's stop affordance would be inert during loading.
    if (inFlight.current && command !== "stop") return;
    if (!isTauriRuntime()) {
      if (command === "reload") {
        setLoading(true);
        setError(null);
        setRevision((value) => value + 1);
      }
      return;
    }
    const request = command === "stop" ? sequence.current : ++sequence.current;
    const eventsBefore = pageLoadEvents.current;
    let dispatched = false;
    if (command === "stop") {
      window.clearTimeout(graceTimer.current);
      pageLoading.current = false;
    } else {
      inFlight.current = true;
      setPending(true);
      setLoading(true);
    }
    try {
      const state = await browserAction(command, viewId);
      if (mounted.current && request === sequence.current) {
        if (state) accept(state.url);
        setError(null);
        dispatched = command !== "stop";
      }
    } catch (cause) {
      if (mounted.current && request === sequence.current)
        setError(errorMessage(cause));
    } finally {
      if (mounted.current && request === sequence.current) {
        inFlight.current = false;
        setPending(false);
        if (dispatched) settleLoading(eventsBefore);
        else setLoading(false);
      }
    }
  };
  /** Zoom, print, devtools and data clearing: no navigation, no loading state. */
  const command = async (name: BrowserCommandAction) => {
    const state = await browserAction(name, viewId);
    if (mounted.current && typeof state?.zoom === "number" && Number.isFinite(state.zoom)) setZoom(state.zoom);
    return state;
  };
  return {
    address,
    setAddress,
    activeUrl,
    loading,
    setLoading,
    pending,
    error,
    setError,
    revision,
    editing,
    load,
    action,
    command,
    zoom,
    viewId,
  };
}
