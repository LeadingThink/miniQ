import { MobileUpdatePrompt } from "./components/MobileUpdatePrompt";
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { isNativeMobileApp } from "./mobileRuntime";
import { MobileAppearanceSheet } from "./components/MobileAppearanceSheet";
import { MobileEntry } from "./components/MobileEntry";
import { isRemoteBrowserEntry, loadRemoteCredentials, type RemoteCredentials } from "./remoteAccess";
import { getAppearance, subscribeAppearance, storeTheme, type ThemeId } from "./theme";
import { sharedSessionId } from "./sharing";
import { hasMobilePrivacyConsent } from "./mobilePrivacy";
import { DesktopHostProvider } from "./desktopHost";
const SharedSessionPage = lazy(() => import("./components/SharedSessionPage").then((module) => ({ default: module.SharedSessionPage })));
const RemoteWorkbench = lazy(() => import("./RemoteWorkbench").then((module) => ({ default: module.RemoteWorkbench })));
const ConnectedApp = lazy(() => import("./ConnectedApp"));

export type { PendingApproval } from "./hooks/useSessionFeed";

export default function App() {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const shareId = sharedSessionId();
  if (shareId !== null) return <Suspense fallback={<p role="status">正在加载分享…</p>}><SharedSessionPage key={shareId} id={shareId} /></Suspense>;

  if (isRemoteBrowserEntry()) return <><RemoteGate theme={theme} onThemeChange={storeTheme} /><MobileUpdatePrompt /></>;
  const desktop = <Suspense fallback={<p role="status" className="remote-restoring">正在加载工作台…</p>}><ConnectedApp theme={theme} onThemeChange={storeTheme} /></Suspense>;
  return <DesktopHostProvider>{desktop}</DesktopHostProvider>;
}

/** Remembered credentials reconnect straight to the desktop, so the API key —
 * which is painful to retype on a phone — is only entered once. */
function RemoteGate(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [credentials, setCredentials] = useState<RemoteCredentials | null>(null);
  const [phase, setPhase] = useState<"restoring" | "entry" | "active">("restoring");

  useEffect(() => {
    let disposed = false;
    const settle = (credentials: RemoteCredentials | null) => {
      if (!disposed) { setCredentials(credentials); setPhase(credentials && hasMobilePrivacyConsent() ? "active" : "entry"); }
    };
    void loadRemoteCredentials().then(settle, () => settle(null));
    return () => {
      disposed = true;
    };
  }, []);

  if (phase === "restoring") return <p role="status" className="remote-restoring">正在恢复远程连接…</p>;
  if (phase === "entry") return <MobileEntry onRemote={() => { void loadRemoteCredentials().then((value) => { if (value) { setCredentials(value); setPhase("active"); } }); }} />;
  return <><Suspense fallback={<p role="status" className="remote-restoring">正在加载远程工作台…</p>}>{credentials && <RemoteWorkbench key={JSON.stringify([credentials.apiKey, credentials.relayUrl])} onExit={() => { setCredentials(null); setPhase("entry"); }} credentials={credentials} theme={props.theme} onThemeChange={props.onThemeChange} />}</Suspense>{isNativeMobileApp() && <button className="mobile-workspace-appearance" onClick={() => setAppearanceOpen(true)}>外观</button>}{appearanceOpen && <MobileAppearanceSheet onClose={() => setAppearanceOpen(false)} />}</>;
}
