import { useState } from "react";
import { AppShell } from "./components/AppShell";
import { useMiniqApp } from "./hooks/useMiniqApp";
import { readStoredTheme, storeTheme, type ThemeId } from "./theme";

export type { PendingApproval } from "./hooks/useSessionFeed";

export default function App() {
  const app = useMiniqApp();
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);

  const setTheme = (nextTheme: ThemeId) => {
    storeTheme(nextTheme);
    setThemeState(nextTheme);
  };

  return <AppShell app={app} theme={theme} onThemeChange={setTheme} />;
}
