import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../rpc";

interface McpServerView {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  status: string;
  tools?: { name: string; description?: string }[];
  error?: string;
}

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  configured: "已配置",
  error: "错误",
};

export function McpPanel(props: { client: RpcClient }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");

  const refresh = useCallback(
    async (connect: boolean) => {
      setStatus(connect ? "正在连接服务器..." : null);
      try {
        const res = await props.client.call<{ servers: McpServerView[] }>("mcp.list", {
          connect,
        });
        setServers(res.servers);
        setStatus(null);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    },
    [props.client],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const saveServers = async (next: McpServerView[]) => {
    await props.client.call("mcp.update", {
      servers: next.map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args,
        enabled: s.enabled,
      })),
    });
    await refresh(false);
  };

  const addServer = async () => {
    if (!name.trim() || !command.trim()) return;
    const next = [
      ...servers,
      {
        name: name.trim(),
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        enabled: true,
        status: "configured",
      },
    ];
    await saveServers(next);
    setName("");
    setCommand("");
    setArgs("");
  };

  const toggle = async (server: McpServerView) => {
    await saveServers(
      servers.map((s) =>
        s.name === server.name ? { ...s, enabled: !s.enabled } : s,
      ),
    );
  };

  const remove = async (server: McpServerView) => {
    if (!window.confirm(`移除 MCP 服务器"${server.name}"?`)) return;
    await saveServers(servers.filter((s) => s.name !== server.name));
  };

  return (
    <div className="page">
      <div className="page-inner wide">
        <div className="page-header">
          <div className="page-title">MCP</div>
          <div className="page-sub">
            接入外部工具与服务(Model Context Protocol),扩展 agent 的能力。
          </div>
        </div>
        {status && <div className="settings-status">{status}</div>}

        {servers.length === 0 ? (
          <div className="schedule-empty compact">
            <div className="schedule-empty-icon">🔌</div>
            <div className="schedule-empty-title">还没有 MCP 服务器</div>
            <div className="schedule-empty-sub">
              在下方添加一个 stdio MCP 服务器,agent 即可调用它提供的工具
            </div>
          </div>
        ) : (
          <div className="card-grid">
            {servers.map((server) => (
              <div
                key={server.name}
                className={`asset-card ${server.enabled ? "" : "off"}`}
              >
                <div className="asset-card-head">
                  <div className="asset-icon">{server.name.slice(0, 1).toUpperCase()}</div>
                  <div className="asset-name" title={server.name}>
                    {server.name}
                  </div>
                  <div
                    className={`switch ${server.enabled ? "on" : ""}`}
                    title={server.enabled ? "点击禁用" : "点击启用"}
                    onClick={() => void toggle(server)}
                  >
                    <div className="switch-knob" />
                  </div>
                </div>
                <div className="asset-cmd" title={`${server.command} ${server.args.join(" ")}`}>
                  {server.command} {server.args.join(" ")}
                </div>
                {server.tools && (
                  <div className="asset-desc">
                    工具: {server.tools.map((t) => t.name).join(", ") || "(无)"}
                  </div>
                )}
                {server.error && (
                  <div className="asset-desc" style={{ color: "var(--danger)" }}>
                    {server.error}
                  </div>
                )}
                <div className="asset-meta">
                  <span
                    className={`badge ${
                      server.status === "running"
                        ? "succeeded"
                        : server.status === "error"
                          ? "failed"
                          : ""
                    }`}
                  >
                    {STATUS_LABEL[server.status] ?? server.status}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button className="ghost danger" onClick={() => void remove(server)}>
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

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
            <button className="secondary" onClick={() => refresh(true)}>
              测试连接
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
