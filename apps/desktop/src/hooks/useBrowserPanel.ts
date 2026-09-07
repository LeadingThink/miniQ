import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  browserAction,
  closeBrowser,
  currentBrowser,
  openBrowser,
  resizeBrowser,
  setBrowserVisible,
  shouldSyncBrowserAddress,
} from "../browserWorkbench";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";

export function useBrowserPanel(url: string, surface: RefObject<HTMLDivElement>, suspended = false) {
  const [viewId] = useState(() => crypto.randomUUID());
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
    setAddress((value) => (shouldSyncBrowserAddress(editing.current, value, previous) ? next : value));
  }, []);
  const load = useCallback(
    async (target: string) => {
      const element = surface.current;
      if (!element) return;
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
    void load(url);
  }, [url, load]);

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
    if (!element || !isTauriRuntime()) return;
    let frame = 0;
    let disposed = false;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        void resizeBrowser({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewId).catch((cause) => {
          if (!disposed) setError(errorMessage(cause));
        });
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [surface, viewId]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let polling = false;
    const refresh = async () => {
      if (disposed || polling || inFlight.current || document.visibilityState === "hidden") return;
      polling = true;
      const request = sequence.current;
      try {
        const state = await currentBrowser(viewId);
        if (!disposed && request === sequence.current && state) accept(state.url);
      } catch (cause) {
        if (!disposed && request === sequence.current) setError(`无法同步浏览器状态：${errorMessage(cause)}`);
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
  }, [viewId, accept]);

  const action = async (command: "back" | "forward" | "reload" | "stop") => {
    if (inFlight.current) return;
    if (!isTauriRuntime()) {
      if (command === "reload") {
        setLoading(true);
        setError(null);
        setRevision((value) => value + 1);
      }
      return;
    }
    const request = ++sequence.current;
    inFlight.current = true;
    setPending(true);
    try {
      const state = await browserAction(command, viewId);
      if (mounted.current && request === sequence.current) {
        if (state) accept(state.url);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current && request === sequence.current) setError(errorMessage(cause));
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
