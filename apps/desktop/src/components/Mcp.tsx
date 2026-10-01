import { Plug } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { EmptyState } from "./ui/EmptyState";
import { Switch } from "./ui/Switch";
import { showUndoToast, useToast } from "./ui/Toast";

interface McpServerView {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  status: string;
  tools?: { name: string; description?: string }[];
  error?: string;
  source?: "settings" | "plugin";
  pluginId?: string;
  pluginName?: string;
  description?: string | null;
  readOnly?: boolean;
}

/** Plugin-provided servers are managed by their plugin, never by `mcp.update`. */
export function isPluginServer(server: McpServerView): boolean {
  return server.source === "plugin";
}

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  shadowed: "被覆盖",
  configured: "已配置",
  error: "错误",
};

function useMcpServers(client: RpcClient) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const generation = useRef(0);
  const request = useRef(0);
  const busy = useRef(false);
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const toast = useToast();

  const refresh = useCallback(async (connect: boolean) => {
    const owner = generation.current;
    const id = ++request.current;
    setLoading(true);
    setConnecting(connect);
    setLoadError(null);
    try {
      const result = await client.call<{ servers: McpServerView[] }>("mcp.list", { connect });
      if (owner === generation.current && id === request.current) setServers(result.servers);
    } catch (error) {
      if (owner === generation.current && id === request.current) setLoadError(errorMessage(error));
    } finally {
      if (owner === generation.current && id === request.current) {
        setLoading(false);
        setConnecting(false);
        busy.current = false;
      }
    }
  }, [client]);

  useEffect(() => {
    generation.current += 1;
    setServers([]);
    setHidden(new Set());
    setSaving(false);
    setSaveError(null);
    busy.current = true;
    void refresh(false);
    return () => { generation.current += 1; };
  }, [refresh]);

  const reload = (connect: boolean) => {
    if (busy.current) return;
    busy.current = true;
    void refresh(connect);
  };

  const saveServers = async (next: McpServerView[], expectedGeneration = generation.current) => {
    if (expectedGeneration !== generation.current || busy.current || loadError !== null) return false;
    busy.current = true;
    const owner = generation.current;
    setSaving(true);
    setSaveError(null);
    try {
      await client.call("mcp.update", {
        servers: next.filter((server) => !isPluginServer(server)).map(({ name, command, args, enabled }) => ({ name, command, args, enabled })),
      });
      if (owner !== generation.current) return false;
      await refresh(false);
      return owner === generation.current;
    } catch (error) {
      if (owner === generation.current) setSaveError(errorMessage(error));
      return false;
    } finally {
      if (owner === generation.current) {
        busy.current = false;
        setSaving(false);
      }
    }
  };

  const add = (name: string, command: string, args: string) => saveServers([
    ...serversRef.current,
    { name: name.trim(), command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [], enabled: true, status: "configured" },
  ]);

  const toggle = (server: McpServerView) => saveServers(
    serversRef.current.map((candidate) => candidate.name === server.name ? { ...candidate, enabled: !candidate.enabled } : candidate),
  );

  const unhide = (name: string) => setHidden((current) => {
    const next = new Set(current); next.delete(name); return next;
  });

  const remove = async (server: McpServerView) => {
    if (busy.current || loadError !== null) return;
    const owner = generation.current;
    setHidden((current) => new Set(current).add(server.name));
    showUndoToast(toast, {
      message: `已移除 MCP 服务器“${server.name}”`,
      onUndo: () => { if (owner === generation.current) unhide(server.name); },
      onCommit: () => {
        if (owner !== generation.current) return;
        void saveServers(serversRef.current.filter((candidate) => candidate.name !== server.name), owner)
          .finally(() => { if (owner === generation.current) unhide(server.name); });
      },
    });
  };

  return {
    servers: servers.filter((server) => !hidden.has(server.name)), loading, connecting, saving,
    loadError, saveError, disabled: loading || saving || loadError !== null,
    reload, add, toggle, remove,
  };
}
function McpServerCard(props: {
  server: McpServerView;
  disabled: boolean;
  onToggle: (server: McpServerView) => void;
  onRemove: (server: McpServerView) => void;
}) {
  const { server } = props;
  const pluginServer = isPluginServer(server);
  const badgeClass =
    server.status === "running"
      ? "succeeded"
      : server.status === "error"
        ? "failed"
        : "";
  return (
    <div className={`asset-card ${server.enabled ? "" : "off"}`}>
      <div className="asset-card-head">
        <div className="asset-icon">{server.name.slice(0, 1).toUpperCase()}</div>
        <div className="asset-name" title={server.name}>
          {server.name}
        </div>
        {!pluginServer && (
          <Switch
            disabled={props.disabled}
            checked={server.enabled}
            label={`${server.enabled ? "停用" : "启用"}${server.name}`}
            title={server.enabled ? "点击禁用" : "点击启用"}
            onChange={() => props.onToggle(server)}
          />
        )}
      </div>
      {pluginServer && (
        <div className="asset-desc">
          来自插件 {server.pluginName ?? server.pluginId}（只读，在“插件”页启停）
        </div>
      )}
      {pluginServer && server.description && (
        <div className="asset-desc">{server.description}</div>
      )}
      <div className="asset-cmd" title={`${server.command} ${server.args.join(" ")}`}>
        {server.command} {server.args.join(" ")}
      </div>
      {server.tools && (
        <div className="asset-desc">
          工具: {server.tools.map((tool) => tool.name).join(", ") || "(无)"}
        </div>
      )}
      {server.error && (
        <div className="asset-desc" style={{ color: "var(--danger)" }}>
          {server.error}
        </div>
      )}
      <div className="asset-meta">
        <span className={`badge ${badgeClass}`}>
          {STATUS_LABEL[server.status] ?? server.status}
        </span>
        <span style={{ flex: 1 }} />
        {!pluginServer && (
          <button className="ghost danger" disabled={props.disabled} onClick={() => props.onRemove(server)}>
            移除
          </button>
        )}
      </div>
    </div>
  );
}

function McpServerList(props: {
  servers: McpServerView[];
  disabled: boolean;
  onToggle: (server: McpServerView) => void;
  onRemove: (server: McpServerView) => void;
}) {
  if (props.servers.length === 0) {
    return (
      <EmptyState
        compact
        icon={<Plug size={24} />}
        title="还没有 MCP 服务器"
        description="在下方添加一个 stdio MCP 服务器，agent 即可调用它提供的工具"
      />
    );
  }
  return (
    <div className="card-grid">
      {props.servers.map((server) => (
        <McpServerCard
          key={`${server.source ?? "settings"}:${server.pluginId ?? ""}:${server.name}`}
          server={server}
          disabled={props.disabled}
          onToggle={props.onToggle}
          onRemove={props.onRemove}
        />
      ))}
    </div>
  );
}

function AddServerForm(props: {
  onAdd: (name: string, command: string, args: string) => Promise<boolean>;
  disabled: boolean;
  busy: boolean;
  onTest: () => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");

  const addServer = async () => {
    if (props.disabled || !name.trim() || !command.trim()) return;
    if (!await props.onAdd(name, command, args)) return;
    setName("");
    setCommand("");
    setArgs("");
  };

  return (
    <div className="form-card">
      <div className="form-card-title">添加服务器</div>
      <label>
        名称
        <input disabled={props.busy} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
      </label>
      <label>
        命令
        <input
          disabled={props.busy}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npx / python / 可执行文件路径"
        />
      </label>
      <label>
        参数(空格分隔)
        <input
          disabled={props.busy}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder="-y @some/mcp-server"
        />
      </label>
      <div className="settings-actions">
        <button onClick={addServer} disabled={props.disabled || !name.trim() || !command.trim()}>
          添加
        </button>
        <button className="secondary" disabled={props.busy} onClick={props.onTest}>
          测试连接
        </button>
      </div>
    </div>
  );
}

export function McpPanel(props: { client: RpcClient }) {
  const model = useMcpServers(props.client);
  return (
    <div className="page">
      <div className="page-inner wide">
        <div className="page-header">
          <div className="page-title">MCP</div>
          <div className="page-sub">
            接入外部工具与服务(Model Context Protocol),扩展 agent 的能力。
          </div>
        </div>
        {model.loading && <div className="settings-status" role="status">{model.connecting ? "正在连接服务器..." : "正在加载 MCP 服务器..."}</div>}
        {model.saving && <div className="settings-status" role="status">正在保存...</div>}
        {model.loadError !== null && (
          <div className="settings-status" role="alert">
            加载 MCP 服务器失败: {model.loadError}
            <button disabled={model.loading || model.saving} onClick={() => model.reload(false)}>重试</button>
          </div>
        )}
        {model.saveError !== null && <div className="settings-status" role="alert">保存 MCP 服务器失败: {model.saveError}</div>}
        {(model.loading || model.loadError !== null) ? null : <McpServerList
          disabled={model.disabled}
          servers={model.servers}
          onToggle={(server) => void model.toggle(server)}
          onRemove={(server) => void model.remove(server)}
        />}
        <AddServerForm disabled={model.disabled} busy={model.loading || model.saving} onAdd={model.add} onTest={() => model.reload(true)} />
      </div>
    </div>
  );
}
