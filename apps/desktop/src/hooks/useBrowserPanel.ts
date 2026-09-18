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
} from "../browserWorkbench";
import {
  buildBrowserAutomationScript,
  parseBrowserScriptResult,
} from "../browserAutomationScript";
import { registerEmbeddedBrowser } from "../embeddedBrowserDriver";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import { useOpenDialog } from "./useOpenDialog";

export function useBrowserPanel(
  url: string,
  surface: RefObject<HTMLDivElement>,
  requestedSuspension = false,
  requestedViewId?: string,
  requestedBrowserSessionId?: string,
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
  const editing = useRef(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const accept = useCallback((next: string) => {
    const previous = active.current;
    active.current = next;
    setActiveUrl(next);
    setAddress((value) =>
      shouldSyncBrowserAddress(editing.current, value, previous) ? next : value,
    );
  }, []);
  const load = useCallback(
    async (target: string) => {
      const element = surface.current;
      if (!element) return;
      if (inFlight.current) return;
      const request = ++sequence.current;
      inFlight.current = true;
      setPending(true);
      setLoading(true);
      setError(null);
      setAddress(target);
      try {
        const rect = element.getBoundingClientRect();
        const state = await openBrowser(
          target,
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          viewId,
          !suspendedRef.current,
        );
        if (!mounted.current) {
          await closeBrowser(viewId);
          return;
        }
        if (request !== sequence.current) return;
        await setBrowserVisible(viewId, !suspendedRef.current);
        if (!mounted.current || request !== sequence.current) return;
        accept(state.url);
        setAddress(state.url);
        setRevision((value) => value + 1);
      } catch (cause) {
        if (mounted.current && request === sequence.current) {
          setError(errorMessage(cause));
          setLoading(false);
        }
        throw cause;
      } finally {
        if (mounted.current && request === sequence.current) {
          inFlight.current = false;
          setPending(false);
          if (isTauriRuntime()) setLoading(false);
        }
      }
    },
    [surface, viewId, accept],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
      // An obsolete panel can close only its own child webview.
      void closeBrowser(viewId).catch(() => {});
    };
  }, [viewId]);
  useEffect(() => {
    if (!requestedBrowserSessionId) return;
    return registerEmbeddedBrowser(requestedBrowserSessionId, {
      capabilities: browserCapabilities,
      execute: async (operation, arguments_) => {
        const observe = async (snapshotArguments = arguments_) => parseBrowserScriptResult(await evaluateBrowser(
          viewId,
          buildBrowserAutomationScript("snapshot", snapshotArguments, viewId),
        ));
        const freshSnapshotArguments = () => ({
          nextObservationId: arguments_.nextObservationId,
          offset: arguments_.offset,
          limit: arguments_.limit,
        });
        const observeAfterMutation = async () => {
          // A click on a submit/next button may start a full navigation or an
          // async SPA update. The first evaluation can still see the old
          // document, so wait for a short DOM-stability window and bind the
          // next action to the last fresh observation. This deliberately does
          // not wait for network-idle: pages can keep analytics/websocket
          // requests open forever, and DOM stability is the only signal this
          // adapter can establish without pretending that navigation finished.
          const settleDeadline = Date.now() + 1_800;
          const stableSamplesRequired = 3;
          await new Promise((resolve) => window.setTimeout(resolve, 80));
          let latest: ReturnType<typeof parseBrowserScriptResult> | undefined;
          let previousSignature: string | undefined;
          let stableSamples = 0;
          let lastError: unknown;
          while (Date.now() < settleDeadline) {
            try {
              const candidate = await observe(freshSnapshotArguments());
              latest = candidate;
              const signature = JSON.stringify({
                documentId: candidate.documentId,
                url: candidate.url,
                title: candidate.title,
                readyState: candidate.readyState,
                items: candidate.items,
                textLines: candidate.textLines,
                total: candidate.total,
                totalTextLines: candidate.totalTextLines,
              });
              if (candidate.readyState !== "loading" && signature === previousSignature) {
                stableSamples += 1;
              } else {
                previousSignature = signature;
                stableSamples = 1;
              }
              if (candidate.readyState !== "loading" && stableSamples >= stableSamplesRequired) {
                return candidate;
              }
            } catch (cause) {
              // A document navigation can briefly make evaluate() fail. Retry
              // only the observation; the user action has already dispatched
              // and must never be replayed after an observation error.
              lastError = cause;
              previousSignature = undefined;
              stableSamples = 0;
            }
            const remaining = settleDeadline - Date.now();
            if (remaining <= 0) break;
            await new Promise((resolve) => window.setTimeout(resolve, Math.min(120, remaining)));
          }
          if (latest) return latest;
          if (lastError) throw lastError;
          throw new Error("浏览器动作后未能获取新的页面观察");
        };
        if (operation === "close") {
          await closeBrowser(viewId);
          return { closed: true };
        }
        if (operation === "open" || operation === "navigate") {
          const target = arguments_.url;
          if (typeof target !== "string") throw new Error("浏览器导航缺少 URL");
          await load(target);
          return observeAfterMutation();
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
          await browserAction(operation, viewId);
          const result = await observeAfterMutation();
          accept(result.url);
          return result;
        }
        if (operation === "stop") {
          await browserAction("stop", viewId);
          return observe();
        }
        if (operation === "setVisible") {
          if (typeof arguments_.visible !== "boolean")
            throw new Error("setVisible 缺少 visible 参数");
          await setBrowserVisible(viewId, arguments_.visible);
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
          const result = parseBrowserScriptResult(raw);
          if (["click", "doubleClick", "drag", "select", "type", "press"].includes(operation)) {
            return observeAfterMutation();
          }
          return result;
        }
        throw new Error(`此平台的内嵌浏览器不支持 ${operation}`);
      },
    });
  }, [load, requestedBrowserSessionId, surface, viewId]);
  useEffect(() => {
    if (requestedBrowserSessionId) return;
    void load(url).catch(() => {});
  }, [url, load, requestedBrowserSessionId]);

  useEffect(() => {
    let disposed = false;
    void setBrowserVisible(viewId, !suspended).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => {
      disposed = true;
    };
  }, [viewId, suspended]);

  useEffect(() => {
    const element = surface.current;
    if (!element || !isTauriRuntime() || suspended) return;
    let disposed = false;
    const resize = () => {
      // ResizeObserver already batches layout. A second animation frame can
      // stop in a hidden WebKit view, leaving its native child at stale bounds.
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      void resizeBrowser(
        { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewId,
      ).catch((cause) => {
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
  }, [surface, viewId, suspended]);

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

  const action = async (command: "back" | "forward" | "reload" | "stop") => {
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
    if (command !== "stop") {
      inFlight.current = true;
      setPending(true);
      setLoading(true);
    }
    try {
      const state = await browserAction(command, viewId);
      if (mounted.current && request === sequence.current) {
        if (state) accept(state.url);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current && request === sequence.current)
        setError(errorMessage(cause));
    } finally {
      if (mounted.current && request === sequence.current) {
        inFlight.current = false;
        setPending(false);
        setLoading(false);
      }
    }
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
  };
}
