import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SshConnections } from "../components/SshConnections";
import { isTauriRuntime } from "../runtime";
import { applyTheme } from "../theme";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/interactions.css";
import "../styles/remote.css";
import "../styles/experience.css";

// Development-only production-component fixture. No SSH process, daemon, model,
// real host, real credential or network request is used. Only ssh_hosts is mocked.
const exampleHosts = [
  {
    alias: "demo-development",
    hostName: "development.example.test",
    user: "demo",
    port: 22,
  },
  {
    alias: "demo-research",
    hostName: "research.example.test",
    user: "research",
    port: 2222,
  },
  { alias: "demo-offline", hostName: "offline.example.test", user: "demo" },
];
let failDiscovery = false;

function Fixture() {
  const [host, setHost] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [discoveryFailure, setDiscoveryFailure] = useState(false);
  const [saved, setSaved] = useState(false);
  const selectHost = async (next: string | null) => {
    setPending(true);
    setError(null);
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    if (next?.includes("offline"))
      setError("演示主机暂不可达，请检查网络；当前执行主机保持不变。");
    else setHost(next);
    setPending(false);
  };
  return (
    <main
      style={{
        height: "100dvh",
        overflow: "auto",
        padding: 16,
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <header style={{ maxWidth: 700, margin: "0 auto 16px" }}>
        <h1 style={{ fontSize: 21 }}>SSH 连接界面验收</h1>
        <p style={{ fontSize: 13, lineHeight: 1.7 }}>
          真实生产组件，全部为合成主机。连接成功/失败为演示，不会访问任何电脑。
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 12,
          }}
        >
          <button
            onClick={() => {
              setDark(!dark);
              applyTheme(dark ? "jade" : "night");
            }}
          >
            切换主题
          </button>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
            }}
          >
            <input
              type="checkbox"
              checked={discoveryFailure}
              onChange={(event) => {
                setDiscoveryFailure(event.target.checked);
                failDiscovery = event.target.checked;
              }}
            />
            下次刷新模拟配置读取失败
          </label>
        </div>
      </header>
      <form
        className="settings-panel"
        style={{
          width: "100%",
          maxWidth: 700,
          maxHeight: "none",
          margin: "0 auto",
        }}
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(true);
        }}
      >
        <div className="settings-header">
          <h2>设置 · 服务与远程</h2>
        </div>
        <SshConnections
          activeHost={host}
          pending={pending}
          error={error}
          onSelectHost={(next) => void selectHost(next)}
        />
        <p style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.7 }}>
          选择 demo-offline
          可验收失败保留当前主机；手动输入其他合成名称可验收添加、移除和返回本机。
        </p>
        <button type="submit" className="secondary">
          演示外层设置保存
        </button>
        {saved && (
          <p role="status">
            演示设置表单已提交。添加主机时按 Enter 不应触发这里。
          </p>
        )}
      </form>
    </main>
  );
}

if (import.meta.env.DEV && !isTauriRuntime()) {
  // Keep production host preferences untouched even though this fixture shares
  // the Vite origin. Storage interception is confined to this document's realm.
  const originalGet = Storage.prototype.getItem;
  const originalSet = Storage.prototype.setItem;
  const storageKey = (key: string) =>
    key === "miniq.ssh.saved-hosts" ? "miniq.fixture.ssh.saved-hosts" : key;
  Storage.prototype.getItem = function (key) {
    return originalGet.call(this, storageKey(key));
  };
  Storage.prototype.setItem = function (key, value) {
    originalSet.call(this, storageKey(key), value);
  };
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string) => {
        if (command !== "ssh_hosts")
          throw new Error(`演示页没有接入 ${command}`);
        if (failDiscovery) throw new Error("演示 SSH 配置不可读");
        return exampleHosts;
      },
    },
  });
  applyTheme("jade");
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
