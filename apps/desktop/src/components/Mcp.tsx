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
  const [status, setStatus] = useState<string | null>(null);
  // Names hidden optimistically while an undo toast is pending.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const toast = useToast();

  const refresh = useCallback(
    async (connect: boolean) => {
      setStatus(connect ? "正在连接服务器..." : null);
      try {
        const result = await client.call<{ servers: McpServerView[] }>("mcp.list", { connect });
        setServers(result.servers);
        setStatus(null);
      } catch (error) {
        setStatus(errorMessage(error));
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const saveServers = async (next: McpServerView[]) => {
    await client.call("mcp.update", {
      servers: next.filter((server) => !isPluginServer(server)).map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        enabled: server.enabled,
      })),
    });
    await refresh(false);
  };

  const add = async (name: string, command: string, args: string) => {
    await saveServers([
      ...servers,
      {
        name: name.trim(),
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        enabled: true,
        status: "configured",
      },
    ]);
  };

  const toggle = async (server: McpServerView) => {
    await saveServers(
      servers.map((candidate) =>
        candidate.name === server.name
          ? { ...candidate, enabled: !candidate.enabled }
          : candidate,
      ),
    );
  };

  const unhide = (name: string) =>
    setHidden((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });

  const remove = async (server: McpServerView) => {
    setHidden((current) => new Set(current).add(server.name));
    showUndoToast(toast, {
      message: `已移除 MCP 服务器“${server.name}”`,
      onUndo: () => unhide(server.name),
      onCommit: () => {
        void saveServers(
          serversRef.current.filter((candidate) => candidate.name !== server.name),
        )
          .catch((error: unknown) => setStatus(errorMessage(error)))
          .finally(() => unhide(server.name));
      },
    });
  };

  const visible = servers.filter((server) => !hidden.has(server.name));
  return { servers: visible, status, refresh, add, toggle, remove };
}

function McpServerCard(props: {
  server: McpServerView;
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
          <button className="ghost danger" onClick={() => props.onRemove(server)}>
            移除
          </button>
        )}
      </div>
    </div>
  );
}

function McpServerList(props: {
  servers: McpServerView[];
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
          onToggle={props.onToggle}
          onRemove={props.onRemove}
        />
      ))}
    </div>
  );
}

function AddServerForm(props: {
  onAdd: (name: string, command: string, args: string) => Promise<void>;
  onTest: () => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");

  const addServer = async () => {
    if (!name.trim() || !command.trim()) return;
    await props.onAdd(name, command, args);
    setName("");
    setCommand("");
    setArgs("");
  };

  return (
    <div className="form-card">
      <div className="form-card-title">添加服务器</div>
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
      </label>
      <label>
        命令
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npx / python / 可执行文件路径"
        />
      </label>
      <label>
        参数(空格分隔)
        <input
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder="-y @some/mcp-server"
        />
      </label>
      <div className="settings-actions">
        <button onClick={addServer} disabled={!name.trim() || !command.trim()}>
          添加
        </button>
        <button className="secondary" onClick={props.onTest}>
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
        {model.status && <div className="settings-status">{model.status}</div>}
        <McpServerList
          servers={model.servers}
          onToggle={(server) => void model.toggle(server)}
          onRemove={(server) => void model.remove(server)}
        />
        <AddServerForm onAdd={model.add} onTest={() => void model.refresh(true)} />
      </div>
    </div>
  );
}
