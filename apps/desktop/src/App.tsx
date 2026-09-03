import { useState } from "react";
import { AppShell } from "./components/AppShell";
import { MobileEntry } from "./components/MobileEntry";
import { useMiniqApp } from "./hooks/useMiniqApp";
import { isRemoteBrowserEntry } from "./remoteAccess";
import { readStoredTheme, storeTheme, type ThemeId } from "./theme";

export type { PendingApproval } from "./hooks/useSessionFeed";

function ConnectedApp(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const app = useMiniqApp();
  return <AppShell app={app} theme={props.theme} onThemeChange={props.onThemeChange} />;
}

export default function App() {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);
  const [remoteActive, setRemoteActive] = useState(false);

  const setTheme = (nextTheme: ThemeId) => {
    storeTheme(nextTheme);
    setThemeState(nextTheme);
  };

  if (isRemoteBrowserEntry() && !remoteActive) {
    return <MobileEntry onRemote={() => setRemoteActive(true)} />;
  }
  return <ConnectedApp theme={theme} onThemeChange={setTheme} />;
}
