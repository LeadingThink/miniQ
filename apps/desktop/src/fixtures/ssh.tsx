import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopHostProvider, useDesktopHost, hostDraftKey } from "../desktopHost";
import { SshConnections } from "../components/SshConnections";
import { UnifiedSidebar } from "../components/UnifiedSidebar";
import { SshFixtureRoot } from "./sshModel";
import { hostKey } from "../hostWorkspace";
import { applyTheme } from "../theme";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/interactions.css";
import "../styles/remote.css";
import "../styles/experience.css";

const root = new SshFixtureRoot();
root.mobile = new URLSearchParams(location.search).get("mobile") === "1";
const noop = () => {};
function Fixture() {
  const host = useDesktopHost()!;
  const catalog = host.catalogs[hostKey(host.host)];
  const [dark, setDark] = useState(false);
  const app = {
    client: host.clientFor(host.host), catalog: { ...catalog, currentSessionId: host.destination.sessionId, selectedWorkspace: catalog?.workspaces[0], refreshSessions: () => host.refreshCatalog(host.host), refreshWorkspaces: () => host.refreshCatalog(host.host) },
    navigation: { sidebarCollapsed: host.sidebarCollapsed, setSidebarCollapsed: host.setSidebarCollapsed, setShowSearch: noop, setShowExternalImport: noop, setPage: noop, setShowSettings: noop, setEditingWorkspaceId: noop },
    actions: { newChat: () => void host.selectHost(host.host, { workspaceId: null, sessionId: null }) },
    setError: noop, updater: { supported: false, state: { phase: "idle" }, checkNow: noop, install: noop },
  } as unknown as MiniqAppController;
  return <div className={`app ${host.sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <UnifiedSidebar app={app} />
    <main className="main" style={{ overflow: "auto", padding: 20 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button onClick={() => host.setSidebarCollapsed(!host.sidebarCollapsed)}>项目与会话</button>
        <button onClick={() => { setDark(!dark); applyTheme(dark ? "jade" : "night"); }}>切换主题</button>
        <a href={`?port=1&token=fixture&mobile=${root.mobile ? "0" : "1"}`}>{root.mobile ? "桌面模式" : "移动远程模式"}</a>
      </div>
      <h1 style={{ fontSize: 21 }}>统一 SSH 工作区验收</h1>
      <p>当前电脑：{host.host ?? "本机"}。此页面使用生产侧栏、连接设置与主机状态；所有数据均为合成，不会访问网络或真实电脑。</p>
      <p>三台电脑故意使用相同项目、会话 ID，可测试导航与草稿隔离。切换电脑后搜索、折叠状态及侧栏宽度保持。</p>
      <Draft key={hostKey(host.host)} host={host.host} />
      {host.destination.sessionId && <p>已选择会话：{host.destination.sessionId}</p>}
      <div className="settings-panel" style={{ width: "100%", maxWidth: 760, maxHeight: "none", marginTop: 20 }}>
        <SshConnections {...host.registry} activeHost={host.host} canManage={!root.mobile} pending={host.pending} error={host.error} onSelectHost={(target) => void host.selectHost(target)} onSave={host.saveHost} onRemove={host.removeHost} onDisconnect={host.disconnectHost} onRefresh={host.refreshHosts} />
      </div>
    </main>
  </div>;
}
function Draft({ host }: { host: string | null }) {
  const key = hostDraftKey(host, "fixture-draft");
  const [value, setValue] = useState(() => sessionStorage.getItem(key) ?? "");
  return <textarea aria-label="当前电脑草稿" placeholder="写下草稿，切换电脑验证隔离和保留" value={value} onChange={(event) => { setValue(event.target.value); sessionStorage.setItem(key, event.target.value); }} style={{ width: "100%", minHeight: 75 }} />;
}
if (import.meta.env.DEV) {
  const url = new URL(location.href); url.searchParams.set("port", "1"); url.searchParams.set("token", "fixture"); history.replaceState(null, "", url);
  applyTheme("jade");
  createRoot(document.getElementById("root")!).render(<DesktopHostProvider root={root}><Fixture /></DesktopHostProvider>);
}
