import { ArrowLeft, ArrowRight, ExternalLink, Globe2, RefreshCw, Square, X } from "lucide-react";
import { useRef } from "react";
import { openExternalUrl } from "../externalLinks";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import { normalizeBrowserUrl } from "../browserWorkbench";
import { useBrowserPanel } from "../hooks/useBrowserPanel";

export function BrowserPanel(props: {
  url: string;
  suspended?: boolean;
  onNavigate: (url: string) => void;
  onClose: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const browser = useBrowserPanel(props.url, surface, props.suspended);
  const native = isTauriRuntime();
  const reloadAction = native && browser.loading ? "stop" : "reload";
  return (
    <aside className="browser-panel" aria-label="网页浏览器">
      <header className="browser-toolbar">
        <Globe2 size={17} />
        <button
          type="button"
          className="icon-button"
          title="后退"
          aria-label="后退"
          disabled={!native || browser.pending}
          onClick={() => void browser.action("back")}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="前进"
          aria-label="前进"
          disabled={!native || browser.pending}
          onClick={() => void browser.action("forward")}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={reloadAction === "stop" ? "停止加载" : "刷新"}
          aria-label={reloadAction === "stop" ? "停止加载" : "刷新"}
          disabled={browser.pending}
          onClick={() => void browser.action(reloadAction)}
        >
          {reloadAction === "stop" ? <Square size={13} /> : <RefreshCw size={15} />}
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const url = normalizeBrowserUrl(browser.address);
              if (url === props.url) void browser.load(url);
              else props.onNavigate(url);
            } catch (cause) {
              browser.setError(errorMessage(cause));
            }
          }}
        >
          <input
            aria-label="网址"
            value={browser.address}
            onChange={(event) => browser.setAddress(event.target.value)}
            onFocus={(event) => {
              browser.editing.current = true;
              event.currentTarget.select();
            }}
            onBlur={() => {
              browser.editing.current = false;
            }}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </form>
        <button
          type="button"
          className="icon-button"
          title="在系统浏览器中打开"
          aria-label="在系统浏览器中打开"
          onClick={() =>
            void openExternalUrl(browser.activeUrl).catch((cause) => browser.setError(errorMessage(cause)))
          }
        >
          <ExternalLink size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="关闭浏览器"
          aria-label="关闭浏览器"
          onClick={props.onClose}
        >
          <X size={17} />
        </button>
      </header>
      {browser.error && (
        <div className="review-error browser-error" role="alert">
          <span>{browser.error}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="重试打开网页"
            title="重试打开网页"
            disabled={browser.pending}
            onClick={() => void browser.load(browser.activeUrl)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      )}
      <div ref={surface} className="browser-surface">
        {!native && (
          <iframe
            key={browser.revision}
            src={browser.activeUrl}
            title="网页预览"
            sandbox="allow-downloads allow-forms allow-popups allow-scripts allow-same-origin"
            onLoad={() => browser.setLoading(false)}
            onError={() => {
              browser.setLoading(false);
              browser.setError("网页加载失败");
            }}
          />
        )}
      </div>
      <footer className="browser-status">
        <span className={browser.loading ? "browser-loading" : ""} />
        <span>{browser.loading ? "正在加载" : native ? "内置浏览器" : "网页预览"}</span>
        <code title={browser.activeUrl}>{browser.activeUrl}</code>
      </footer>
    </aside>
  );
}
