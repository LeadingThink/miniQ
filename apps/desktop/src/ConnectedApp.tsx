import { AppShell } from "./components/AppShell";
import { useMiniqApp } from "./hooks/useMiniqApp";
import { SessionFileAccess } from "./sessionFileAccess";
import type { ThemeId } from "./theme";
import { memo, useLayoutEffect, useState } from "react";
import { useDesktopHost } from "./desktopHost";
import { hostKey } from "./hostWorkspace";
import { UnifiedSidebar } from "./components/UnifiedSidebar";
import type { MiniqAppController } from "./hooks/useMiniqApp";

export default function ConnectedApp(props: {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}) {
  const desktop = useDesktopHost();
  const [controller, setController] = useState<MiniqAppController | null>(null);
  if (!desktop) return <HostContent {...props} />;
  return <div className={`app ${desktop.sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    {controller && <UnifiedSidebar app={controller} />}
    <div style={{ display: desktop.host === null ? "contents" : "none" }}>
      <HostContent {...props} active={desktop.host === null} publish={setController} />
    </div>
    {desktop.host !== null && <HostContent key={hostKey(desktop.host)} {...props} publish={setController} />}
  </div>;
}

const HostContent = memo(function HostContent(props: { theme: ThemeId; onThemeChange: (theme: ThemeId) => void; active?: boolean; publish?: (app: MiniqAppController) => void }) {
  const active = props.active !== false;
  const app = useMiniqApp(active);
  useLayoutEffect(() => { if (active) props.publish?.(app); }, [props.publish, app, active]);
  return (
    <SessionFileAccess client={app.client} sessionId={app.catalog.currentSessionId}>
      <AppShell active={active} contentOnly={!!props.publish} app={app} theme={props.theme} onThemeChange={props.onThemeChange} />
    </SessionFileAccess>
  );
});
