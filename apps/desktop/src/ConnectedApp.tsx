import { AppShell } from "./components/AppShell";
import { useMiniqApp } from "./hooks/useMiniqApp";
import { SessionFileAccess } from "./sessionFileAccess";
import type { ThemeId } from "./theme";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useDesktopHost } from "./desktopHost";
import { hostKey } from "./hostWorkspace";
import { AppMenuBar } from "./components/AppMenuBar";
import type { MiniqAppController } from "./hooks/useMiniqApp";
import { ZaiwenLoginDialog } from "./components/ZaiwenLoginDialog";
import { getZaiwenSession, restoreZaiwenSession, type ZaiwenSession } from "./zaiwenAuth";
import type { AppPlatform } from "./components/PlatformSwitcher";
import { ZaiwenSiteView } from "./components/ZaiwenSiteView";

export default function ConnectedApp(props: {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}) {
  const desktop = useDesktopHost();
  const [controller, setController] = useState<MiniqAppController | null>(null);
  const [platform, setPlatform] = useState<AppPlatform>("miniq");
  const [zaiwenSession, setZaiwenSession] = useState<ZaiwenSession | null>(getZaiwenSession);
  const [loginOpen, setLoginOpen] = useState(false);
  const switchRequest = useRef(0);
  const cloud = platform === "zaiwen";
  const viewingCloud = cloud && !!zaiwenSession;
  const switchPlatform = useCallback((next: AppPlatform) => {
    const request = ++switchRequest.current;
    if (next === "miniq") { setLoginOpen(false); setPlatform("miniq"); return; }
    const cached = getZaiwenSession();
    if (!cached) { setLoginOpen(true); return; }
    void restoreZaiwenSession().then((session) => {
      if (request !== switchRequest.current) return;
      if (session) { setZaiwenSession(session); setPlatform("zaiwen"); }
      else { setZaiwenSession(null); setLoginOpen(true); }
    });
  }, []);
  if (!desktop) return <HostContent {...props} />;
  return <div className="desktop-workspace">
    <AppMenuBar app={controller} platform={platform} onPlatformChange={switchPlatform} zaiwenUser={zaiwenSession?.user.nick || zaiwenSession?.user.phone} />
    <div className={`app ${desktop.sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {zaiwenSession && <ZaiwenSiteView session={zaiwenSession} active={viewingCloud} />}
      <div style={{ display: desktop.host === null && !viewingCloud ? "contents" : "none" }} inert={viewingCloud}>
        <HostContent {...props} active={!viewingCloud && desktop.host === null} publish={setController} />
      </div>
      {desktop.host !== null && <div style={{ display: viewingCloud ? "none" : "contents" }} inert={viewingCloud}>
        <HostContent key={hostKey(desktop.host)} {...props} active={!viewingCloud} publish={setController} />
      </div>}
    </div>
    <ZaiwenLoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onLogin={(session) => {
      setZaiwenSession(session); setLoginOpen(false);
      setPlatform("zaiwen");
    }} />
  </div>;
}

const HostContent = memo(function HostContent(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void; active?: boolean; publish?: (app: MiniqAppController) => void }) {
  const active = props.active !== false;
  const app = useMiniqApp(active);
  useLayoutEffect(() => { if (active) props.publish?.(app); }, [props.publish, app, active]);
  return (
    <SessionFileAccess
      client={app.client}
      sessionId={app.catalog.currentSessionId}
      workspacePath={app.catalog.currentSession?.workingDirectory ?? app.catalog.currentWorkspace?.path}
      workspacePaths={app.catalog.currentWorkspacePaths}
      authorizedFiles={app.preview?.authorizedFiles}
    >
      <AppShell active={active} contentOnly={!!props.publish} app={app} theme={props.theme} onThemeChange={props.onThemeChange} />
    </SessionFileAccess>
  );
});
