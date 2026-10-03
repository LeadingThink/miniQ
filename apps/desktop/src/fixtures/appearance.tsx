import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Code, Settings } from "lucide-react";
import { SettingsPanel } from "../components/Settings";
import type { RpcClient } from "../rpc";
import { getAppearance, initializeAppearance, storeAppearanceMode, storeTheme, subscribeAppearance, themeById, isThemeId } from "../theme";
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
import "../styles/living-background.css";
import { initializeBackground, storeBackground } from "../background";
import { LivingBackground } from "../components/LivingBackground";
import { Timeline } from "../components/Timeline";
import type { Message } from "../types";

// `?chat` shows a sample conversation so wallpaper legibility can be judged.
const chatPreview = new URLSearchParams(location.search).has("chat");
const chatMessages: Message[] = [
  ["user", "帮我看下这个仓库的背景效果，动态壁纸要能透出来。"],
  ["assistant", "已检查外观设置。\n\n- 主区域不再整块磨砂\n- 只给输入框和消息保留阅读底色\n- 侧边栏保留轻量分隔\n\n可以切换不同壁纸确认可读性。"],
  ["user", "再确认一下浅色和深色主题。"],
  ["assistant", "两种主题都使用同一套局部阅读保护，文字保持清晰，壁纸在消息之间露出。"],
].map(([role, content], index) => ({
  id: `bg-${index}`,
  sessionId: "background-fixture",
  role: role as Message["role"],
  content,
  createdAt: new Date(Date.UTC(2026, 9, 3, 8, index)).toISOString(),
}));
const noop = () => undefined;
const asyncNoop = async () => undefined;

function ChatPreview() {
  return (
    <main className="main" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <Timeline
          sessionId="background-fixture"
          messages={chatMessages}
          toolCalls={[]}
          approvals={[]}
          questions={[]}
          plan={[]}
          artifacts={[]}
          queue={[]}
          streamingText=""
          turnProgress={null}
          busy={false}
          onResolveApproval={noop}
          onResolveQuestion={noop}
          onRollback={noop}
          onOpenFile={noop}
          onOpenUrl={noop}
          onSteerQueued={asyncNoop}
          onRemoveQueued={asyncNoop}
          onUpdateQueued={asyncNoop}
          onRewrite={async () => true}
          onError={noop}
        />
      </section>
      <div className="composer-card" style={{ margin: "0 24px 20px", padding: 16, minHeight: 72 }}>输入消息…</div>
    </main>
  );
}

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
  const [open, setOpen] = useState(!chatPreview);
  const [sourceOpen, setSourceOpen] = useState(false);
  return (
    <>
    <LivingBackground />
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
      {chatPreview ? <ChatPreview /> : <main className="main" />}
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
    </>
  );
}

if (import.meta.env.DEV) {
  initializeAppearance();
  initializeBackground();
  const previewBackground = new URLSearchParams(window.location.search).get("background");
  if (previewBackground) storeBackground(previewBackground);
  const previewTheme = new URLSearchParams(window.location.search).get("theme");
  if (isThemeId(previewTheme)) {
    storeAppearanceMode(themeById(previewTheme as Parameters<typeof storeTheme>[0]).mode);
    storeTheme(previewTheme as Parameters<typeof storeTheme>[0]);
  }
  createRoot(document.getElementById("root")!).render(<AppearanceFixture />);
}
