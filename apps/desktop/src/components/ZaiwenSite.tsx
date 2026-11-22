import { useEffect, useRef } from "react";
import { listenBrowserEvent } from "../browserEvents";
import { useBrowserPanel } from "../hooks/useBrowserPanel";
import { openLinkWindow } from "../linkActions";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import "./ZaiwenSite.css";

const SITE_URL = "https://chat.zaiwenai.com/";

/** The main site owns its login, navigation and conversations. */
export function ZaiwenSite({ active, onReadyChange }: {
  active: boolean;
  onReadyChange: (ready: boolean) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const browser = useBrowserPanel(SITE_URL, surface, !active, "zaiwen-site");
  const ready = !browser.loading && !browser.loadError;
  useEffect(() => { onReadyChange(ready); }, [ready, onReadyChange]);
  const { viewId, setError } = browser;
  useEffect(() => listenBrowserEvent("browser://new-window", viewId, ({ url }) => {
    void openLinkWindow(url).catch((cause) => setError(errorMessage(cause)));
  }), [viewId, setError]);
  const failure = browser.loadError;
  const retry = () => { void browser.load(failure?.url ?? browser.activeUrl).catch(() => {}); };
  return <main className="zaiwen-site" aria-label="在问主站" style={{ display: active ? undefined : "none" }} inert={!active}>
    {browser.error && <div className="zaiwen-site-error" role="alert">
      <span>{browser.error}</span><button type="button" disabled={browser.pending} onClick={retry}>重试打开在问</button>
    </div>}
    <div ref={surface} className="zaiwen-site-surface" aria-busy={browser.loading}>
      {failure ? <section className="zaiwen-site-error" role="alert">
        <h2>无法打开在问主站</h2>
        <p>{failure.message}</p>
        <p>{failure.url}</p>
        <code>{failure.code}</code>
        <button type="button" disabled={browser.pending} onClick={retry}>重试打开在问</button>
      </section> : !isTauriRuntime() ? <iframe key={browser.revision} src={browser.activeUrl} title="在问主站网页"
        sandbox="allow-downloads allow-forms allow-popups allow-scripts allow-same-origin"
        onLoad={() => browser.setLoading(false)} onError={() => {
          browser.setLoading(false); setError("在问主站加载失败");
        }} /> : browser.loading ? <p role="status">正在加载在问主站…</p> : null}
    </div>
  </main>;
}
