import { useEffect, useState } from "react";
import { FolderPlus, Package, RefreshCw, Trash2, Upload } from "lucide-react";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import type { PluginInfo, PluginListResult } from "../types";
import { RemotePathDialog } from "./RemotePathDialog";
import { ApprovalRulesSection } from "./ApprovalRules";
import { ConfirmDialog } from "./ui/Dialog";
import { EmptyState } from "./ui/EmptyState";

/** "连接器：linear" label for plugins that contribute MCP servers. */
export function connectorLabel(plugin: Pick<PluginInfo, "mcpServers">): string | null {
  const names = (plugin.mcpServers ?? []).map((server) => server.name);
  return names.length > 0 ? `连接器：${names.join(", ")}` : null;
}

export function PluginsPanel(props: { client: RpcClient }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [remotePicker, setRemotePicker] = useState(false);
  const [remotePluginUpdate, setRemotePluginUpdate] = useState(false);
  const [confirming, setConfirming] = useState<{ kind: "trust" | "uninstall"; plugin: PluginInfo } | null>(null);

  useEffect(() => {
    void props.client
      .call<PluginListResult>("plugin.list")
      .then((result) => setPlugins(result.plugins))
      .catch((error) => setStatus(String(error)));
    return props.client.onEvent((event) => {
      if (event.type === "plugins_changed") setPlugins(event.plugins);
    });
  }, [props.client]);

  const install = async () => {
    if (props.client.sshHost) {
      setRemotePluginUpdate(false);
      setRemotePicker(true);
      return;
    }
    let path: string | null = null;
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择插件文件夹",
      });
      path = typeof selected === "string" ? selected : null;
    } else {
      path = window.prompt("插件文件夹（绝对路径）:");
    }
    if (!path) return;

    setBusy("install");
    setStatus(null);
    try {
      const result = await props.client.call<PluginListResult>("plugin.install", { path });
      setPlugins(result.plugins);
      setStatus("插件已安装");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (plugin: PluginInfo, enabled: boolean, confirmTrustedCode = false) => {
    if (enabled && plugin.trustedCode && !confirmTrustedCode) {
      setConfirming({ kind: "trust", plugin });
      return;
    }

    setBusy(plugin.id);
    setStatus(null);
    try {
      const result = await props.client.call<PluginListResult>("plugin.setEnabled", {
        id: plugin.id,
        enabled: Boolean(enabled),
        confirmTrustedCode: Boolean(confirmTrustedCode),
      });
      setPlugins(result.plugins);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const update = async (plugin: PluginInfo) => {
    if (props.client.sshHost) {
      setRemotePluginUpdate(true);
      setRemotePicker(true);
      return;
    }
    let path: string | null = null;
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title: `选择 ${plugin.name} 的新版目录` });
      path = typeof selected === "string" ? selected : null;
    } else {
      path = window.prompt("新版插件文件夹（绝对路径）:");
    }
    if (!path) return;
    setBusy(plugin.id);
    setStatus(null);
    try {
      const result = await props.client.call<PluginListResult>("plugin.install", { path, update: true });
      setPlugins(result.plugins);
      setStatus(`已更新 ${plugin.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const reload = async (plugin: PluginInfo) => {
    setBusy(plugin.id);
    setStatus(null);
    try {
      const result = await props.client.call<PluginListResult>("plugin.reload", {
        id: plugin.id,
      });
      setPlugins(result.plugins);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (plugin: PluginInfo, confirmed = false) => {
    if (!confirmed) {
      setConfirming({ kind: "uninstall", plugin });
      return;
    }
    setBusy(plugin.id);
    setStatus(null);
    try {
      const result = await props.client.call<PluginListResult>("plugin.uninstall", {
        id: plugin.id,
      });
      setPlugins(result.plugins);
      setStatus("插件已卸载");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <ConfirmDialog
        open={confirming !== null}
        tone="danger"
        title={
          confirming?.kind === "trust"
            ? `启用可信 Node.js 插件“${confirming.plugin.name}”？`
            : `卸载“${confirming?.plugin.name ?? ""}”？`
        }
        description={
          confirming?.kind === "trust"
            ? "它能够以当前用户权限运行代码，请仅启用你信任的插件。"
            : "将删除已安装的插件文件，此操作无法撤销。"
        }
        confirmLabel={confirming?.kind === "trust" ? "启用插件" : "卸载"}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const current = confirming;
          setConfirming(null);
          if (!current) return;
          if (current.kind === "trust") void setEnabled(current.plugin, true, true);
          else void uninstall(current.plugin, true);
        }}
      />
      {remotePicker && props.client.sshHost && <RemotePathDialog host={props.client.sshHost} purpose="plugin"
        onClose={() => setRemotePicker(false)} onSubmit={async (path) => {
          const result = await props.client.call<PluginListResult>("plugin.install", { path, update: remotePluginUpdate });
          setPlugins(result.plugins);
          setStatus(remotePluginUpdate ? "远程插件已更新" : "远程插件已安装");
        }} />}
      <div className="page-inner wide">
        <div className="page-header plugin-page-header">
          <div>
            <div className="page-title">插件</div>
            <div className="page-sub">安装和管理本地 WASM、Node.js 插件与版本化技能包。</div>
          </div>
          <button disabled={busy !== null} onClick={() => void install()}>
            <FolderPlus size={15} />
            添加插件
          </button>
        </div>
        {status && <div className="settings-status">{status}</div>}
        {plugins.length === 0 ? (
          <EmptyState
            icon={<Package size={28} />}
            title="还没有插件"
            description="内置插件会在 miniQ 启动时自动安装；也可以添加一个包含 manifest.toml 的插件或技能包文件夹"
          />
        ) : (
          <div className="card-grid">
            {plugins.map((plugin) => (
              <div className={`asset-card plugin-card ${plugin.enabled ? "" : "off"}`} key={plugin.id}>
                <div className="asset-card-head">
                  <div className="asset-icon"><Package size={17} /></div>
                  <div className="plugin-card-title">
                    <div className="asset-name">{plugin.name}</div>
                    <div className="asset-cmd">{plugin.id} · {plugin.version || "invalid"}</div>
                  </div>
                  <button
                    className={`switch ${plugin.enabled ? "on" : ""}`}
                    role="switch"
                    aria-checked={plugin.enabled}
                    aria-label={`${plugin.enabled ? "停用" : "启用"}${plugin.name}`}
                    disabled={busy !== null}
                    onClick={() => void setEnabled(plugin, !plugin.enabled)}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
                {plugin.description && <div className="plugin-card-meta">{plugin.description}</div>}
                <div className="plugin-badges">
                  {plugin.bundled && <span className="badge" title="随 miniQ 提供，可停用，不可卸载">内置</span>}
                  <span className="badge">{plugin.runtime}</span>
                  <span className={`badge ${plugin.status}`}>{plugin.status}</span>
                  {plugin.runtime === "node" && plugin.processState === "failed" && (
                    <span className={`badge ${plugin.processState}`}>{plugin.processState}</span>
                  )}
                </div>
                <div className="plugin-card-meta">入口：{plugin.entry}</div>
                <div className="plugin-card-meta">
                  能力：{plugin.capabilities.join(", ") || "无"}
                </div>
                <div className="plugin-card-meta">
                  权限：{plugin.permissions.join(", ") || "无"}
                </div>
                {(plugin.skills ?? []).length > 0 && (
                  <div className="plugin-card-meta">技能包：{(plugin.skills ?? []).join(", ")}</div>
                )}
                {connectorLabel(plugin) && (
                  <div className="plugin-card-meta" title={(plugin.mcpServers ?? []).map((server) => server.description ? `${server.name}: ${server.description}` : server.name).join("\n")}>
                    {connectorLabel(plugin)}
                  </div>
                )}
                {(plugin.dependencies ?? []).length > 0 && (
                  <div className="plugin-card-meta">
                    依赖：{(plugin.dependencies ?? []).map((dependency) => `${dependency.command} ${dependency.available ? "✓" : "缺少"}`).join("、")}
                  </div>
                )}
                {plugin.trustedCode && !plugin.trustConfirmed && (
                  <div className="plugin-warning">启用前需要确认可信代码权限。</div>
                )}
                {plugin.error && <div className="plugin-error">{plugin.error}</div>}
                <div className="asset-meta plugin-card-actions">
                  {!plugin.bundled && (
                    <button
                      className="ghost"
                      disabled={busy !== null}
                      onClick={() => void update(plugin)}
                      title="从本地目录导入同一插件的新版本"
                    >
                      <Upload size={14} />
                      更新
                    </button>
                  )}
                  <button
                    className="ghost"
                    disabled={busy !== null || !plugin.enabled}
                    onClick={() => void reload(plugin)}
                    title="重新加载当前版本"
                  >
                    <RefreshCw size={14} />
                    重载
                  </button>
                  <span style={{ flex: 1 }} />
                  {!plugin.bundled && (
                    <button
                      className="ghost danger"
                      disabled={busy !== null}
                      onClick={() => void uninstall(plugin)}
                    >
                      <Trash2 size={14} />
                      卸载
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <ApprovalRulesSection client={props.client} />
      </div>
    </div>
  );
}
