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

export function McpPanel(props: { client: RpcClient; onClose: () => void }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");

  const refresh = useCallback(
    async (connect: boolean) => {
      setStatus(connect ? "Connecting to servers..." : null);
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
    if (!window.confirm(`Remove MCP server "${server.name}"?`)) return;
    await saveServers(servers.filter((s) => s.name !== server.name));
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div className="settings-panel skills-panel" onClick={(e) => e.stopPropagation()}>
        <h2>MCP servers</h2>
        {status && <div className="settings-status">{status}</div>}
        <div className="skill-list">
          {servers.length === 0 && (
            <div className="settings-status">No MCP servers configured.</div>
          )}
          {servers.map((server) => (
            <div key={server.name} className="skill-row">
              <div className="skill-row-main">
                <span className="tool-name">{server.name}</span>
                <span
                  className={`badge ${
                    server.status === "running"
                      ? "succeeded"
                      : server.status === "error"
                        ? "failed"
                        : ""
                  }`}
                >
                  {server.status}
                </span>
                <div className="sub">
                  {server.command} {server.args.join(" ")}
                </div>
                {server.tools && (
                  <div className="sub">
                    tools: {server.tools.map((t) => t.name).join(", ") || "(none)"}
                  </div>
                )}
                {server.error && <div className="sub">{server.error}</div>}
              </div>
              <button className={server.enabled ? "secondary" : ""} onClick={() => toggle(server)}>
                {server.enabled ? "Disable" : "Enable"}
              </button>
              <button className="danger" onClick={() => remove(server)}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <h2>Add server</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
        </label>
        <label>
          Command
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx / python / path-to-binary"
          />
        </label>
        <label>
          Arguments (space separated)
          <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @some/mcp-server" />
        </label>
        <div className="approval-actions">
          <button onClick={addServer} disabled={!name.trim() || !command.trim()}>
            Add
          </button>
          <button className="secondary" onClick={() => refresh(true)}>
            Test connections
          </button>
          <button className="secondary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
