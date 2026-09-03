import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  browserAction,
  closeBrowser,
  currentBrowser,
  normalizeBrowserUrl,
  openBrowser,
  resizeBrowser,
  type BrowserBounds,
  shouldSyncBrowserAddress,
} from "../browserWorkbench";
import { errorMessage } from "../errorMessage";
import { openExternalUrl } from "../externalLinks";
import { isTauriRuntime } from "../runtime";

function boundsFor(element: HTMLElement): BrowserBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function BrowserPanel(props: {
  url: string;
  onNavigate: (url: string) => void;
  onClose: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const editingAddressRef = useRef(false);
  const [address, setAddress] = useState(props.url);
  const [activeUrl, setActiveUrl] = useState(props.url);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let cancelled = false;
    setAddress(props.url);
    setLoading(true);
    void openBrowser(props.url, boundsFor(surface))
      .then((state) => {
        if (cancelled) return;
        setActiveUrl(state.url);
        setAddress(state.url);
        setError(null);
      })
      .catch((cause) => !cancelled && setError(errorMessage(cause)))
      .finally(() => !cancelled && setLoading(false));

    let resizeFrame: number | null = null;
    const scheduleResize = () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        void resizeBrowser(boundsFor(surface)).catch((cause) => {
          if (!cancelled) setError(`无法调整浏览器窗口：${errorMessage(cause)}`);
        });
      });
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(surface);
    window.addEventListener("resize", scheduleResize);
    return () => {
      cancelled = true;
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleResize);
    };
  }, [props.url]);

  useEffect(() => () => { void closeBrowser(); }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const refreshState = () => {
      if (document.visibilityState === "hidden") return;
      void currentBrowser().then((state) => {
        if (!state || state.url === activeUrl) return;
        setActiveUrl(state.url);
        setAddress((current) => shouldSyncBrowserAddress(
          editingAddressRef.current,
          current,
          activeUrl,
        ) ? state.url : current);
        setLoading(false);
      }).catch((cause) => setError(`无法同步浏览器状态：${errorMessage(cause)}`));
    };
    const timer = window.setInterval(refreshState, 1500);
    document.addEventListener("visibilitychange", refreshState);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshState);
    };
  }, [activeUrl]);

  const syncAddress = () => new Promise<void>((resolve) => {
    window.setTimeout(() => {
      void currentBrowser().then((state) => {
        if (!state) return;
        setActiveUrl(state.url);
        if (!editingAddressRef.current) setAddress(state.url);
      }).catch((cause) => setError(`无法同步浏览器状态：${errorMessage(cause)}`)).finally(resolve);
    }, 350);
  });

  const runAction = (action: "back" | "forward" | "reload" | "stop") => {
    if (actionPending) return;
    setActionPending(true);
    setLoading(action !== "stop");
    void browserAction(action)
      .then(() => syncAddress())
      .then(() => setError(null))
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => {
        setActionPending(false);
        setLoading(false);
      });
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    try {
      const url = normalizeBrowserUrl(address);
      props.onNavigate(url);
      if (url === props.url) {
        setLoading(true);
        void openBrowser(url, boundsFor(surfaceRef.current!))
          .then((state) => { setActiveUrl(state.url); setError(null); })
          .catch((cause) => setError(errorMessage(cause)))
          .finally(() => setLoading(false));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <aside className="browser-panel" aria-label="网页浏览器">
      <header className="browser-toolbar">
        <Globe2 size={17} />
        <button type="button" className="icon-button" title="后退" aria-label="后退" disabled={actionPending} onClick={() => runAction("back")}>
          <ArrowLeft size={16} />
        </button>
        <button type="button" className="icon-button" title="前进" aria-label="前进" disabled={actionPending} onClick={() => runAction("forward")}>
          <ArrowRight size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          title={loading ? "停止加载" : "刷新"}
          aria-label={loading ? "停止加载" : "刷新"}
          disabled={actionPending}
          onClick={() => runAction(loading ? "stop" : "reload")}
        >
          {loading ? <Square size={13} /> : <RefreshCw size={15} />}
        </button>
        <form onSubmit={navigate}>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              editingAddressRef.current = true;
              event.currentTarget.select();
            }}
            onBlur={() => { editingAddressRef.current = false; }}
            aria-label="网址"
            spellCheck={false}
          />
        </form>
        <button
          className="icon-button"
          type="button"
          title="在系统浏览器中打开"
          aria-label="在系统浏览器中打开"
          onClick={() => void openExternalUrl(activeUrl)
            .then(() => setError(null))
            .catch((cause) => setError(`无法打开系统浏览器：${errorMessage(cause)}`))}
        >
          <ExternalLink size={16} />
        </button>
        <button type="button" className="icon-button" title="关闭浏览器" aria-label="关闭浏览器" onClick={props.onClose}>
          <X size={17} />
        </button>
      </header>
      {error && (
        <div className="review-error browser-error" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost" onClick={() => {
            setError(null);
            setLoading(true);
            const surface = surfaceRef.current;
            if (!surface) return;
            void openBrowser(activeUrl, boundsFor(surface))
              .then((state) => { setActiveUrl(state.url); setAddress(state.url); })
              .catch((cause) => setError(errorMessage(cause)))
              .finally(() => setLoading(false));
          }}>重试</button>
        </div>
      )}
      <div ref={surfaceRef} className="browser-surface">
        {!isTauriRuntime() && activeUrl && (
          <iframe
            src={activeUrl}
            title="网页预览"
            sandbox="allow-downloads allow-forms allow-popups allow-scripts allow-same-origin"
            onLoad={() => { setLoading(false); setError(null); }}
            onError={() => { setLoading(false); setError("网页加载失败"); }}
          />
        )}
      </div>
      <footer className="browser-status">
        <span className={loading ? "browser-loading" : ""} />
        <span>{loading ? "正在加载" : "内置浏览器"}</span>
        <code>{activeUrl}</code>
      </footer>
    </aside>
  );
}
