import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, FolderPlus, Info, MoreHorizontal, Package, RefreshCw, Trash2, Upload } from "lucide-react";
import type { RpcClient } from "../rpc";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import type { PluginInfo, PluginListResult } from "../types";
import { RemotePathDialog } from "./RemotePathDialog";
import { ApprovalRulesSection } from "./ApprovalRules";
import { ConfirmDialog } from "./ui/Dialog";
import { EmptyState } from "./ui/EmptyState";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { Switch } from "./ui/Switch";

/** "连接器：linear" label for plugins that contribute MCP servers. */
export function connectorLabel(plugin: Pick<PluginInfo, "mcpServers">): string | null {
  const names = (plugin.mcpServers ?? []).map((server) => server.name);
  return names.length > 0 ? `连接器：${names.join(", ")}` : null;
}

/** Plugins that failed or still need trust confirmation are listed first. */
export function pluginNeedsAttention(plugin: PluginInfo): boolean {
  return Boolean(plugin.error) || plugin.status === "failed" || plugin.processState === "failed" || (plugin.trustedCode && !plugin.trustConfirmed);
}

const ICON_HUES = [150, 210, 265, 330, 25, 45, 185];

function pluginHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ICON_HUES[hash % ICON_HUES.length];
}

function pluginSummary(plugin: PluginInfo): string {
  if (plugin.description?.trim()) return plugin.description.trim();
  if ((plugin.skills ?? []).length > 0) return `技能包：${plugin.skills.join("、")}`;
  return `${plugin.runtime} 插件`;
}

function PluginRow(props: {
  plugin: PluginInfo;
  busy: boolean;
  expanded: boolean;
  onToggleDetails: () => void;
  onEnabled: (enabled: boolean) => void;
  onUpdate: () => void;
  onReload: () => void;
  onUninstall: () => void;
}) {
  const { plugin } = props;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const connector = connectorLabel(plugin);
  const warning = plugin.error ?? (plugin.trustedCode && !plugin.trustConfirmed ? "启用前需要确认可信代码权限。" : null);
  const detailsId = `plugin-details-${plugin.id}`;
  return (
    <div className={`plugin-row ${plugin.enabled ? "" : "off"} ${props.expanded ? "expanded" : ""}`.trim()}>
      <div className="plugin-row-main">
        <div className="plugin-row-icon" aria-hidden="true" style={{ "--plugin-hue": pluginHue(plugin.id) } as CSSProperties}>
          {plugin.name.trim().charAt(0).toUpperCase() || <Package size={16} />}
        </div>
        <button
          type="button"
          className="plugin-row-text"
          aria-expanded={props.expanded}
          aria-controls={detailsId}
          onClick={props.onToggleDetails}
          title={pluginSummary(plugin)}
        >
          <span className="plugin-row-name">
            {plugin.name}
            {plugin.bundled && <span className="plugin-row-tag" title="随 miniQ 提供，可停用，不可卸载">内置</span>}
          </span>
          <span className="plugin-row-desc">{pluginSummary(plugin)}</span>
          {connector && <span className="plugin-row-desc">{connector}</span>}
          {warning && <span className={`plugin-row-warning ${plugin.error ? "error" : ""}`.trim()}>{warning}</span>}
        </button>
        <div className="plugin-row-actions">
          <Switch
            checked={plugin.enabled}
            label={`${plugin.enabled ? "停用" : "启用"}${plugin.name}`}
            disabled={props.busy}
            onChange={props.onEnabled}
          />
          <button
            ref={moreRef}
            type="button"
            className="ghost plugin-row-more"
            aria-label={`${plugin.name} 更多操作`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={16} />
          </button>
          <Menu open={menuOpen} anchorRef={moreRef} onClose={() => setMenuOpen(false)} label={`${plugin.name} 操作`}>
            <MenuItem icon={props.expanded ? <ChevronDown size={14} /> : <Info size={14} />} onClick={props.onToggleDetails}>
              {props.expanded ? "收起详情" : "查看详情"}
            </MenuItem>
            <MenuItem icon={<RefreshCw size={14} />} disabled={props.busy || !plugin.enabled} onClick={props.onReload}>重载</MenuItem>
            {!plugin.bundled && (
              <MenuItem icon={<Upload size={14} />} disabled={props.busy} onClick={props.onUpdate}>从目录更新…</MenuItem>
            )}
            {!plugin.bundled && (
              <>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={14} />} danger disabled={props.busy} onClick={props.onUninstall}>卸载…</MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>
      {props.expanded && (
        <dl className="plugin-row-details" id={detailsId}>
          <dt>标识</dt><dd>{plugin.id} · {plugin.version || "invalid"}</dd>
          <dt>状态</dt><dd>{plugin.runtime} · {plugin.status}{plugin.runtime === "node" ? ` · ${plugin.processState}` : ""}</dd>
          {plugin.entry && (<><dt>入口</dt><dd>{plugin.entry}</dd></>)}
          <dt>能力</dt><dd>{plugin.capabilities.join(", ") || "无"}</dd>
          <dt>权限</dt><dd>{plugin.permissions.join(", ") || "无"}</dd>
          {(plugin.skills ?? []).length > 0 && (<><dt>技能包</dt><dd>{plugin.skills.join(", ")}</dd></>)}
          {(plugin.mcpServers ?? []).length > 0 && (
            <><dt>连接器</dt><dd>{plugin.mcpServers.map((server) => server.description ? `${server.name}（${server.description}）` : server.name).join("、")}</dd></>
          )}
          {(plugin.dependencies ?? []).length > 0 && (
            <><dt>依赖</dt><dd>{plugin.dependencies.map((dependency) => `${dependency.command} ${dependency.available ? "✓" : "缺少"}`).join("、")}</dd></>
          )}
        </dl>
      )}
    </div>
  );
}

export function PluginsPanel(props: { client: RpcClient }) {
  const epoch = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [remotePicker, setRemotePicker] = useState(false);
  const [remotePluginUpdate, setRemotePluginUpdate] = useState(false);
  const [confirming, setConfirming] = useState<{ kind: "trust" | "uninstall"; plugin: PluginInfo } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const sections = [
    { title: "需要处理", items: plugins.filter(pluginNeedsAttention) },
    { title: "已启用", items: plugins.filter((plugin) => plugin.enabled && !pluginNeedsAttention(plugin)) },
    { title: "未启用", items: plugins.filter((plugin) => !plugin.enabled && !pluginNeedsAttention(plugin)) },
  ];

  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await props.client.call<PluginListResult>("plugin.list");
      if (request === epoch.current) setPlugins(result.plugins);
    } catch (error) {
      if (request === epoch.current) setLoadError(errorMessage(error));
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }, [props.client]);

  useEffect(() => {
    setPlugins([]);
    setStatus(null);
    void refresh();
    const unsubscribe = props.client.onEvent((event) => {
      if (event.type === "plugins_changed") {
        ++epoch.current;
        setPlugins(event.plugins);
        setLoading(false);
        setLoadError(null);
      }
    });
    return () => { ++epoch.current; unsubscribe(); };
  }, [props.client, refresh]);

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
        {loading ? (
          <div role="status" className="settings-status">正在加载插件…</div>
        ) : loadError ? (
          <div role="alert" className="settings-status">
            <p>{loadError}</p>
            <button onClick={() => void refresh()}>重新加载插件</button>
          </div>
        ) : plugins.length === 0 ? (
          <EmptyState
            icon={<Package size={28} />}
            title="还没有插件"
            description="内置插件会在 miniQ 启动时自动安装；也可以添加一个包含 manifest.toml 的插件或技能包文件夹"
          />
        ) : (
          <>
            {sections.map((section) => section.items.length > 0 && (
              <section className="plugin-section" key={section.title} aria-label={section.title}>
                <h3 className="plugin-section-title">{section.title}</h3>
                <div className="plugin-grid">
                  {section.items.map((plugin) => (
                    <PluginRow
                      key={plugin.id}
                      plugin={plugin}
                      busy={busy !== null}
                      expanded={expanded === plugin.id}
                      onToggleDetails={() => setExpanded((current) => (current === plugin.id ? null : plugin.id))}
                      onEnabled={(enabled) => void setEnabled(plugin, enabled)}
                      onUpdate={() => void update(plugin)}
                      onReload={() => void reload(plugin)}
                      onUninstall={() => void uninstall(plugin)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
        <ApprovalRulesSection client={props.client} />
      </div>
    </div>
  );
}
