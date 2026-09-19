import { AppShell } from "./components/AppShell";
import { useMiniqApp } from "./hooks/useMiniqApp";
import { SessionFileAccess } from "./sessionFileAccess";
import type { ThemeId } from "./theme";

export default function ConnectedApp(props: {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}) {
  const app = useMiniqApp();
  return (
    <SessionFileAccess client={app.client} sessionId={app.catalog.currentSessionId}>
      <AppShell app={app} theme={props.theme} onThemeChange={props.onThemeChange} />
    </SessionFileAccess>
  );
}
