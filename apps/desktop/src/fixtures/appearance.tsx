import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Code, Settings } from "lucide-react";
import { SettingsPanel } from "../components/Settings";
import type { RpcClient } from "../rpc";
import { getAppearance, initializeAppearance, storeTheme, subscribeAppearance } from "../theme";
import "@fontsource-variable/inter/wght.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/themes.css";
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
const plugin = (id: string, name: string, description: string | null, extra: Record<string, unknown> = {}) => ({
  id, name, version: "1.0.0", enabled: true, status: "running", tools: [], error: null, description, author: null,
  runtime: "skills", capabilities: ["skills"], permissions: [], trustedCode: false, processState: "stopped",
  entry: "manifest.toml", engineNode: null, trustConfirmed: true, skills: [], dependencies: [], bundled: true,
  mcpServers: [], ...extra,
});
const fixturePlugins = [
  plugin("dev.miniq.computer", "Computer Use", "在后台操作 Mac 应用"),
  plugin("dev.miniq.linear", "Linear", "规划并跟踪产品任务", { mcpServers: [{ name: "linear", description: "Linear issues" }], bundled: false }),
  plugin("dev.miniq.figma", "Figma", "设计稿转代码、生成设计稿"),
  plugin("dev.miniq.remotion", "Remotion", "用 React 制作视频", { enabled: false }),
  plugin("dev.miniq.sentry", "Sentry", "查看最近的 Sentry 问题并定位根因", { enabled: false, bundled: false }),
  plugin("dev.local.node", "本地脚本", null, { runtime: "node", enabled: false, trustedCode: true, trustConfirmed: false, bundled: false }),
];
// No daemon, API key, relay, or live task is accessed by this fixture.
const client = {
  mode: "local",
  onEvent: () => () => {},
  call: async (method: string) => method === "plugin.list"
    ? { plugins: fixturePlugins }
    : method === "approval.rules.list"
    ? { rules: [] }
    : method === "memory.list"
    ? { memories: [], nextCursor: null }
    : method === "model.list"
      ? { models: ["gpt-5.6-sol", "claude-sonnet"] }
      : settings,
  onStatus: () => () => {},
} as unknown as RpcClient;
const FilePreviewPanel = lazy(() =>
  import("../components/FilePreviewPanel").then((module) => ({ default: module.FilePreviewPanel }))
);

const tabParam = new URLSearchParams(location.search).get("tab");
const initialTab = tabParam === "appearance" || tabParam === "plugins" ? tabParam : undefined;

function AppearanceFixture() {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance);
  const [open, setOpen] = useState(true);
  const [sourceOpen, setSourceOpen] = useState(false);
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">miniQ</div>
        <button className="nav-item sidebar-nav-button" type="button" onClick={() => setOpen(true)}>
          <Settings size={16} />
          设置
        </button>
        <button className="nav-item sidebar-nav-button" type="button" onClick={() => setSourceOpen(true)}>
          <Code size={16} />
          源码预览
        </button>
      </aside>
      <main className="main" />
      {sourceOpen && (
        <Suspense fallback={null}>
          <FilePreviewPanel
            workspacePath="/fixture"
            workspacePaths={["/fixture"]}
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
        <SettingsPanel client={client} initialTab={initialTab} theme={theme} onThemeChange={storeTheme} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

if (import.meta.env.DEV) {
  initializeAppearance();
  createRoot(document.getElementById("root")!).render(<AppearanceFixture />);
}
