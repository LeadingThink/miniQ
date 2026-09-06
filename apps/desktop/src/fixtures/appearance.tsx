import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Code, Settings } from "lucide-react";
import { SettingsPanel } from "../components/Settings";
import type { RpcClient } from "../rpc";
import { getAppearance, initializeAppearance, storeTheme, subscribeAppearance } from "../theme";
import "@fontsource-variable/inter/wght.css";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/theme-patterns.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/review.css";
import "../styles/pages.css";
import "../styles/scheduling.css";
import "../styles/remote.css";
import "../styles/experience.css";
import "../styles/theme-picker.css";

const settings = {
  provider: { baseUrl: "https://oneapi.zaiwenai.com/v1", model: "gpt-5.6-sol", apiProtocol: "auto", hasApiKey: false },
  remoteAccess: { enabled: false, relayUrl: "wss://relay.example.test", deviceName: "外观预览", deviceId: "fixture" },
  remoteStatus: { state: "disabled", relayUrl: "", mobileClients: 0 },
};
// No daemon, API key, relay, or live task is accessed by this fixture.
const client = { mode: "local", call: async () => settings } as unknown as RpcClient;
const FilePreviewPanel = lazy(() =>
  import("../components/FilePreviewPanel").then((module) => ({ default: module.FilePreviewPanel }))
);

function AppearanceFixture() {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance);
  const [open, setOpen] = useState(true);
  const [sourceOpen, setSourceOpen] = useState(false);
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">miniQ</div>
        <button className="nav-item" type="button" onClick={() => setOpen(true)}>
          <Settings size={16} />
          设置
        </button>
        <button className="nav-item" type="button" onClick={() => setSourceOpen(true)}>
          <Code size={16} />
          源码预览
        </button>
      </aside>
      <main className="main" />
      {sourceOpen && (
        <Suspense fallback={null}>
          <FilePreviewPanel
            workspacePath="/fixture"
            preview={{
              target: { path: "/fixture/theme.json", line: null, column: null },
              resolvedPath: "/fixture/theme.json",
              content: JSON.stringify({ project: "miniQ", appearance: "source preview" }, null, 2),
              kind: "text",
              mimeType: null,
              dataBase64: null,
              size: null,
              loading: false,
              error: null,
              open: true,
            }}
            onClose={() => setSourceOpen(false)}
            onOpenFile={() => {}}
            onRetry={() => {}}
          />
        </Suspense>
      )}
      {open && (
        <SettingsPanel client={client} theme={theme} onThemeChange={storeTheme} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

if (import.meta.env.DEV) {
  initializeAppearance();
  createRoot(document.getElementById("root")!).render(<AppearanceFixture />);
}
