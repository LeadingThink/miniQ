import { useState, useSyncExternalStore } from "react";
import { AppShell } from "./components/AppShell";
import { MobileEntry } from "./components/MobileEntry";
import { useMiniqApp } from "./hooks/useMiniqApp";
import { SessionFileAccess } from "./sessionFileAccess";
import { isRemoteBrowserEntry } from "./remoteAccess";
import { getAppearance, subscribeAppearance, storeTheme, type ThemeId } from "./theme";

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

  if (isRemoteBrowserEntry() && !remoteActive) {
    return <MobileEntry onRemote={() => setRemoteActive(true)} />;
  }
  return <ConnectedApp theme={theme} onThemeChange={storeTheme} />;
}
