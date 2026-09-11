import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { AppShell } from "./components/AppShell";
import { MobileEntry } from "./components/MobileEntry";
import { useMiniqApp } from "./hooks/useMiniqApp";
import { SessionFileAccess } from "./sessionFileAccess";
import { isRemoteBrowserEntry } from "./remoteAccess";
import { getAppearance, subscribeAppearance, storeTheme, type ThemeId } from "./theme";
import { sharedSessionId } from "./sharing";
const SharedSessionPage = lazy(() => import("./components/SharedSessionPage").then((module) => ({ default: module.SharedSessionPage })));

export type { PendingApproval } from "./hooks/useSessionFeed";

function ConnectedApp(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const app = useMiniqApp();
  return <SessionFileAccess client={app.client} sessionId={app.catalog.currentSessionId}>
    <AppShell app={app} theme={props.theme} onThemeChange={props.onThemeChange} />
  </SessionFileAccess>;
}

export default function App() {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const [remoteActive, setRemoteActive] = useState(false);
  const shareId = sharedSessionId();
  if (shareId !== null) return <Suspense fallback={<p role="status">正在加载分享…</p>}><SharedSessionPage key={shareId} id={shareId} /></Suspense>;

  if (isRemoteBrowserEntry() && !remoteActive) {
    return <MobileEntry onRemote={() => setRemoteActive(true)} />;
  }
  return <ConnectedApp theme={theme} onThemeChange={storeTheme} />;
}
