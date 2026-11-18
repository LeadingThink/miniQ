import { useEffect, useRef } from "react";
import { evaluateBrowser } from "../browserWorkbench";
import { listenBrowserEvent } from "../browserEvents";
import { isTauriRuntime } from "../runtime";
import { useBrowserPanel } from "../hooks/useBrowserPanel";
import type { ZaiwenSession } from "../zaiwenAuth";
import "./ZaiwenSiteView.css";

export const ZAIWEN_SITE_URL = "https://chat.zaiwenai.com/";

export function buildZaiwenSiteAuthScript(token: string): string {
  return `(() => { localStorage.setItem("token", ${JSON.stringify(token)}); localStorage.removeItem("auth-session-id"); return JSON.stringify({ ok: true }); })()`;
}

/** Displays the real 在问 website while keeping its account and conversation UI intact. */
export function ZaiwenSiteView({ session, active = true }: { session: ZaiwenSession; active?: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const browser = useBrowserPanel(ZAIWEN_SITE_URL, surface, !active);
  const action = useRef(browser.action);
  action.current = browser.action;
  const injectedToken = useRef<string | null>(null);

  useEffect(() => {
    injectedToken.current = null;
  }, [session.token]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    return listenBrowserEvent("browser://page-load", browser.viewId, (event) => {
      if (event.phase !== "finished" || injectedToken.current === session.token) return;
      injectedToken.current = session.token;
      void evaluateBrowser(browser.viewId, buildZaiwenSiteAuthScript(session.token))
        .then(() => action.current("reload"))
        .catch((cause) => browser.setError(cause instanceof Error ? cause.message : String(cause)));
    });
  }, [browser.viewId, browser.setError, session.token]);

  return <main className="zaiwen-site-view" aria-label="在问主站" hidden={!active}>
    <div ref={surface} className="zaiwen-site-surface" aria-busy={browser.loading}>
      {!isTauriRuntime() && <iframe key={browser.revision} src={browser.activeUrl} title="在问主站网页" />}
      {browser.loadError && <section className="zaiwen-site-error" role="alert">
        <h2>无法打开在问主站</h2>
        <p>{browser.loadError.message}</p>
        <button type="button" onClick={() => void browser.action("reload")}>重试</button>
      </section>}
    </div>
  </main>;
}
