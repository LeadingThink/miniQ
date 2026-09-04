import { useEffect, useState } from "react";
import { FolderPlus, Package, RefreshCw, Trash2 } from "lucide-react";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import type { PluginInfo, PluginListResult } from "../types";

export function PluginsPanel(props: { client: RpcClient }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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

  const setEnabled = async (plugin: PluginInfo, enabled: boolean) => {
    let confirmTrustedCode = false;
    if (enabled && plugin.trustedCode) {
      confirmTrustedCode = window.confirm(
        `启用可信 Node.js 插件“${plugin.name}”？\n\n` +
          "它能够以当前用户权限运行代码，请仅启用你信任的插件。",
      );
      if (!confirmTrustedCode) return;
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

  const uninstall = async (plugin: PluginInfo) => {
    if (!window.confirm(`卸载“${plugin.name}”并删除已安装的插件文件？`)) return;
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
      <div className="page-inner wide">
        <div className="page-header plugin-page-header">
          <div>
            <div className="page-title">插件</div>
            <div className="page-sub">安装和管理本地 WASM 与 Node.js 插件。</div>
          </div>
          <button disabled={busy !== null} onClick={() => void install()}>
            <FolderPlus size={15} />
            添加插件
          </button>
        </div>
        {status && <div className="settings-status">{status}</div>}
        {plugins.length === 0 ? (
          <div className="schedule-empty">
            <Package className="plugin-empty-icon" size={32} />
            <div className="schedule-empty-title">还没有本地插件</div>
            <div className="schedule-empty-sub">添加一个包含 manifest.toml 的插件文件夹</div>
          </div>
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
                <div className="plugin-badges">
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
                {plugin.trustedCode && !plugin.trustConfirmed && (
                  <div className="plugin-warning">启用前需要确认可信代码权限。</div>
                )}
                {plugin.error && <div className="plugin-error">{plugin.error}</div>}
                <div className="asset-meta plugin-card-actions">
                  <button
                    className="ghost"
                    disabled={busy !== null || !plugin.enabled}
                    onClick={() => void reload(plugin)}
                  >
                    <RefreshCw size={14} />
                    重载
                  </button>
                  <span style={{ flex: 1 }} />
                  <button
                    className="ghost danger"
                    disabled={busy !== null}
                    onClick={() => void uninstall(plugin)}
                  >
                    <Trash2 size={14} />
                    卸载
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}