import { AppShell } from "./components/AppShell";
import { useMiniqApp } from "./hooks/useMiniqApp";
import { SessionFileAccess } from "./sessionFileAccess";
import type { ThemeId } from "./theme";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useDesktopHost } from "./desktopHost";
import { hostKey } from "./hostWorkspace";
import { useZaiwenKeyImport } from "./hooks/useZaiwenKeyImport";
import { ZaiwenKeyDialog } from "./components/ZaiwenKeyDialog";
import { UnifiedSidebar } from "./components/UnifiedSidebar";
import { AppMenuBar } from "./components/AppMenuBar";
import type { MiniqAppController } from "./hooks/useMiniqApp";
import type { AppPlatform } from "./components/PlatformSwitcher";
import { errorMessage } from "./errorMessage";

const ZaiwenSite = lazy(async () => ({ default: (await import("./components/ZaiwenSite")).ZaiwenSite }));

export default function ConnectedApp(props: {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}) {
  const desktop = useDesktopHost();
  const [controller, setController] = useState<MiniqAppController | null>(null);
  const [platform, setPlatform] = useState<AppPlatform>("miniq");
  const [siteOpened, setSiteOpened] = useState(false);
  const [siteReady, setSiteReady] = useState(false);
  const viewingSite = platform === "zaiwen";
  const keyImport = useZaiwenKeyImport(siteOpened && siteReady && desktop?.host === null, !viewingSite, desktop?.root);
  const refreshProvider = controller?.connection.refreshProviderConfiguration;
  const reportError = controller?.setError;
  useEffect(() => {
    if (keyImport.configured && !viewingSite) {
      void refreshProvider?.().catch((cause) => reportError?.(`刷新模型配置失败：${errorMessage(cause)}`));
    }
  }, [keyImport.configured, viewingSite, refreshProvider, reportError]);
  const switchPlatform = useCallback((next: AppPlatform) => {
    if (next === "zaiwen") setSiteOpened(true);
    setPlatform(next);
  }, []);
  if (!desktop) return <HostContent {...props} />;
  return <div className="desktop-workspace">
    <AppMenuBar app={viewingSite ? null : controller} platform={platform} onPlatformChange={switchPlatform} />
    <div className={`app ${desktop.sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={{ display: viewingSite ? "none" : undefined }} inert={viewingSite}>
      {controller && <UnifiedSidebar app={controller} />}
      <div style={{ display: desktop.host === null ? "contents" : "none" }} inert={desktop.host !== null}>
        <HostContent {...props} active={desktop.host === null && !viewingSite} publish={setController} />
      </div>
      {desktop.host !== null && <div style={{ display: "contents" }}>
        <HostContent key={hostKey(desktop.host)} {...props} active={!viewingSite} publish={setController} />
      </div>}
    </div>
    {siteOpened && <Suspense fallback={viewingSite ? <main role="status">正在打开在问…</main> : null}>
      <ZaiwenSite active={viewingSite} onReadyChange={setSiteReady} />
    </Suspense>}
    <ZaiwenKeyDialog open={!viewingSite && siteReady && desktop.host === null} keyImport={keyImport} />
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
