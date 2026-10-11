import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Download,
  ExternalLink,
  FolderOpen,
  Globe2,
  MessageSquare,
  MoreHorizontal,
  Printer,
  RefreshCw,
  Square,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { openExternalUrl } from "../externalLinks";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import {
  resolveBrowserAddress,
  revealBrowserDownload,
  type BrowserCommandAction,
  type BrowserNavigationAction,
} from "../browserWorkbench";
import { listenBrowserEvent, type BrowserDownloadEvent } from "../browserEvents";
import { useBrowserPanel } from "../hooks/useBrowserPanel";
import { CopyButton } from "./CopyButton";
import { ConfirmDialog } from "./ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import "./BrowserPanel.css";

const platformText = () =>
  typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
const isApple = () => /Mac|iPhone|iPad/i.test(platformText());
const isWindows = () => !isApple() && /Win/i.test(platformText());

export function revealDownloadLabel(): string {
  return isApple() ? "在访达中显示" : isWindows() ? "在资源管理器中显示" : "在文件管理器中显示";
}

type BrowserShortcut = Exclude<BrowserNavigationAction, "stop"> | Exclude<BrowserCommandAction, "devtools" | "clear_data">;

/** Browser shortcuts handled while focus is inside the browser panel. */
export function browserShortcut(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): BrowserShortcut | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "r" || (!event.shiftKey && event.code === "KeyR")) return event.shiftKey ? null : "reload";
  if (key === "=" || key === "+" || event.code === "Equal" || event.code === "NumpadAdd") return "zoom_in";
  if (key === "-" || key === "_" || event.code === "Minus" || event.code === "NumpadSubtract") return "zoom_out";
  if (!event.shiftKey && (key === "0" || event.code === "Digit0" || event.code === "Numpad0")) return "zoom_reset";
  if (!event.shiftKey && (key === "p" || event.code === "KeyP")) return "print";
  if (!event.shiftKey && (key === "[" || event.code === "BracketLeft")) return "back";
  if (!event.shiftKey && (key === "]" || event.code === "BracketRight")) return "forward";
  return null;
}

const NOTICE_MS = 4000;
const MAX_DOWNLOADS = 5;

function shortUrl(url: string, limit = 60) {
  return url.length > limit ? `${url.slice(0, limit - 1)}…` : url;
}

export function BrowserPanel(props: {
  url: string;
  viewId?: string;
  browserSessionId?: string;
  active?: boolean;
  suspended?: boolean;
  /** Load the initial URL even though the tab is agent-owned (page popups). */
  autoLoad?: boolean;
  onNavigate: (url: string) => void;
  onClose: () => void;
  onDiscuss?: (url: string) => void;
  /** Document title reported by the page. */
  onTitle?: (title: string) => void;
  /** The page asked for a new window (window.open / target=_blank). */
  onOpenWindow?: (url: string) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [downloads, setDownloads] = useState<BrowserDownloadEvent[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const browser = useBrowserPanel(
    props.url,
    surface,
    // The native page paints above HTML; hide it while our popovers are open.
    props.suspended || props.active === false || menuOpen || confirmClear,
    props.viewId,
    props.browserSessionId,
    props.autoLoad,
  );
  const native = isTauriRuntime();
  const apple = isApple();
  const mod = apple ? "⌘" : "Ctrl+";
  const loadError = browser.loadError ?? null;
  const failedTargetUrl = loadError?.url ?? browser.activeUrl;
  const onNavigate = useRef(props.onNavigate);
  onNavigate.current = props.onNavigate;
  const callbacks = useRef({ onTitle: props.onTitle, onOpenWindow: props.onOpenWindow });
  callbacks.current = { onTitle: props.onTitle, onOpenWindow: props.onOpenWindow };
  const viewId = browser.viewId;
  useEffect(() => {
    const disposers = [
      listenBrowserEvent("browser://title", viewId, (event) => {
        if (typeof event.title === "string") callbacks.current.onTitle?.(event.title);
      }),
      listenBrowserEvent("browser://new-window", viewId, (event) => {
        if (typeof event.url === "string" && /^https?:\/\//i.test(event.url)) callbacks.current.onOpenWindow?.(event.url);
      }),
      listenBrowserEvent("browser://download", viewId, (event) => {
        setDownloads((current) => {
          const index = current.findIndex((item) => item.id === event.id);
          if (index < 0) return [event, ...current].slice(0, MAX_DOWNLOADS);
          const previous = current[index];
          const merged = { ...previous, ...event, fileName: event.fileName || previous.fileName, path: event.path || previous.path };
          return current.map((item, position) => (position === index ? merged : item));
        });
      }),
      listenBrowserEvent("browser://external", viewId, (event) => {
        setNotice(`已用系统应用打开 ${shortUrl(event.url)}`);
      }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [viewId]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const runCommand = useCallback(async (name: BrowserCommandAction) => {
    try {
      await browser.command(name);
    } catch (cause) {
      browser.setError(errorMessage(cause));
    }
  }, [browser]);
  const clearData = async () => {
    setClearing(true);
    try {
      await browser.command("clear_data");
      setNotice("已清除浏览数据");
    } catch (cause) {
      browser.setError(`清除浏览数据失败：${errorMessage(cause)}`);
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };
  const reveal = (path: string) => {
    void revealBrowserDownload(path).catch((cause) => browser.setError(errorMessage(cause)));
  };
  const reportedUrl = useRef(props.url);
  useEffect(() => {
    if (reportedUrl.current === browser.activeUrl) return;
    reportedUrl.current = browser.activeUrl;
    onNavigate.current(browser.activeUrl);
  }, [browser.activeUrl]);
  const reloadAction = native && browser.loading ? "stop" : "reload";
  return (
    <aside
      className={`browser-panel${props.active === false ? " browser-panel-inactive" : ""}`}
      aria-label="网页浏览器"
      onKeyDown={(event) => {
        const shortcut = browserShortcut(event);
        if (shortcut) {
          // Scoped to the panel: the chat composer and other inputs never see
          // these, and app-wide handlers skip prevented events (e.g. ⌘P).
          event.preventDefault();
          event.stopPropagation();
          if (shortcut === "back" || shortcut === "forward" || shortcut === "reload") {
            if (native || shortcut === "reload") void browser.action(shortcut);
          } else if (native) void runCommand(shortcut);
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "l"
        ) {
          event.preventDefault();
          addressInput.current?.focus();
          addressInput.current?.select();
        } else if (event.key === "Escape" && native && browser.loading) {
          event.preventDefault();
          void browser.action("stop");
        }
      }}
    >
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
          disabled={browser.pending && reloadAction !== "stop"}
          onClick={() => void browser.action(reloadAction)}
        >
          {reloadAction === "stop" ? (
            <Square size={13} />
          ) : (
            <RefreshCw size={15} />
          )}
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const url = resolveBrowserAddress(browser.address);
              // URL metadata also changes after redirects and observations.
              // Only this explicit user action should navigate the page.
              void browser.load(url).catch(() => {});
              if (url !== props.url) props.onNavigate(url);
            } catch (cause) {
              browser.setError(errorMessage(cause));
            }
          }}
        >
          <input
            ref={addressInput}
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
            placeholder="搜索或输入网址"
          />
        </form>
        <CopyButton
          content={browser.activeUrl}
          label="复制当前网页链接"
          onError={browser.setError}
        />
        {props.onDiscuss && (
          <button
            type="button"
            className="icon-button"
            title="针对当前网页提问"
            aria-label="针对当前网页提问"
            onClick={() => props.onDiscuss?.(browser.activeUrl)}
          >
            <MessageSquare size={16} />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title="在系统浏览器中打开"
          aria-label="在系统浏览器中打开"
          onClick={() =>
            void openExternalUrl(failedTargetUrl).catch((cause) =>
              browser.setError(errorMessage(cause)),
            )
          }
        >
          <ExternalLink size={16} />
        </button>
        <button
          ref={moreButton}
          type="button"
          className="icon-button"
          title="更多"
          aria-label="更多浏览器操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <MoreHorizontal size={16} />
        </button>
        <Menu
          open={menuOpen}
          anchorRef={moreButton}
          onClose={() => setMenuOpen(false)}
          label="更多浏览器操作"
          className="browser-more-menu"
        >
          <MenuItem icon={<ZoomIn size={14} />} shortcut={`${mod}+`} disabled={!native} onClick={() => void runCommand("zoom_in")}>
            放大
          </MenuItem>
          <MenuItem icon={<ZoomOut size={14} />} shortcut={`${mod}-`} disabled={!native} onClick={() => void runCommand("zoom_out")}>
            缩小
          </MenuItem>
          <MenuItem shortcut={`${mod}0`} disabled={!native} onClick={() => void runCommand("zoom_reset")}>
            实际大小（{Math.round(browser.zoom * 100)}%）
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Printer size={14} />} shortcut={`${mod}P`} disabled={!native} onClick={() => void runCommand("print")}>
            打印
          </MenuItem>
          <MenuItem icon={<Code2 size={14} />} disabled={!native} onClick={() => void runCommand("devtools")}>
            开发者工具
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={14} />} danger disabled={!native} onClick={() => setConfirmClear(true)}>
            清除浏览数据…
          </MenuItem>
        </Menu>
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
            onClick={() => void browser.load(browser.activeUrl).catch(() => {})}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="browser-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="icon-button" aria-label="关闭提示" title="关闭提示" onClick={() => setNotice(null)}>
            <X size={13} />
          </button>
        </div>
      )}
      {downloads.length > 0 && (
        <section className="browser-downloads" aria-label="下载">
          <ul>
            {downloads.map((item) => (
              <li key={item.id} className={`browser-download browser-download-${item.phase}`}>
                <Download size={14} aria-hidden="true" />
                <span className="browser-download-name" title={item.path || item.url}>
                  {item.fileName || item.url}
                </span>
                <span className="browser-download-state">
                  {item.phase === "started" ? "下载中" : item.phase === "finished" ? "已完成" : "失败"}
                </span>
                {item.phase === "finished" && item.path && (
                  <button type="button" className="icon-button" title={revealDownloadLabel()} aria-label={`${revealDownloadLabel()} ${item.fileName}`} onClick={() => reveal(item.path)}>
                    <FolderOpen size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  title="从列表移除"
                  aria-label={`从下载列表移除 ${item.fileName}`}
                  onClick={() => setDownloads((current) => current.filter((entry) => entry.id !== item.id))}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ConfirmDialog
        open={confirmClear}
        title="清除浏览数据？"
        description="将清除内置浏览器的 Cookie 和网站数据，所有标签页中的网站都会退出登录。"
        confirmLabel="清除"
        tone="danger"
        busy={clearing}
        onConfirm={() => void clearData()}
        onCancel={() => setConfirmClear(false)}
      />
      <div
        ref={surface}
        className="browser-surface"
        aria-busy={browser.loading}
        aria-label={loadError ? "网页加载错误" : browser.loading ? "网页加载中" : "网页内容"}
      >
        {loadError ? (
          <section className="browser-error-state" role="alert" aria-labelledby={`browser-load-error-${viewId}`}>
            <div className="browser-error-state-icon" aria-hidden="true">
              <Globe2 size={28} />
            </div>
            <h2 id={`browser-load-error-${viewId}`}>无法访问此站点</h2>
            <p className="browser-error-state-url">{loadError.url}</p>
            <p className="browser-error-state-message">{loadError.message}</p>
            <p className="browser-error-state-code">
              <span>错误代码</span>
              <code>{loadError.code}</code>
            </p>
            <button
              type="button"
              className="browser-error-state-retry"
              disabled={browser.pending}
              onClick={() => void browser.load(loadError.url).catch(() => {})}
            >
              <RefreshCw size={15} />
              重试
            </button>
          </section>
        ) : !native ? (
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
        ) : null}
      </div>
      <footer className="browser-status" role="status" aria-live="polite">
        <span className={browser.loading ? "browser-loading" : ""} />
        <span>
          {loadError ? "加载失败" : browser.loading ? "正在加载" : native ? "内置浏览器" : "网页预览"}
        </span>
        <code title={browser.activeUrl}>{browser.activeUrl}</code>
      </footer>
    </aside>
  );
}
