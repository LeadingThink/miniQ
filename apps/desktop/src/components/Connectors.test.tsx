// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { PluginInfo } from "../types";
import { McpPanel } from "./Mcp";
import { PluginsPanel, connectorLabel } from "./Plugins";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakeClient(handlers: Record<string, (params: unknown) => unknown>) {
  const call = vi.fn(async (method: string, params?: unknown) => {
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected ${method}`);
    return handler(params);
  });
  const client = { call, onEvent: () => () => undefined, sshHost: null } as unknown as RpcClient;
  return { client, call };
}

const linearPlugin: PluginInfo = {
  id: "dev.miniq.linear",
  name: "Linear",
  version: "1.0.0",
  enabled: true,
  status: "running",
  tools: [],
  error: null,
  description: null,
  author: null,
  runtime: "skills",
  capabilities: ["skills"],
  permissions: [],
  trustedCode: false,
  processState: "stopped",
  entry: "",
  engineNode: null,
  trustConfirmed: true,
  skills: ["linear"],
  dependencies: [],
  bundled: false,
  mcpServers: [{ name: "linear", description: "Linear issues" }],
} as unknown as PluginInfo;

describe("plugin connectors", () => {
  it("labels plugins that contribute MCP servers", async () => {
    expect(connectorLabel({ mcpServers: [] })).toBeNull();
    const { client } = fakeClient({ "plugin.list": () => ({ plugins: [linearPlugin] }) });
    render(<PluginsPanel client={client} />);
    expect(await screen.findByText("连接器：linear")).toBeTruthy();
  });

  it("shows plugin MCP servers read-only and never saves them", async () => {
    const { client, call } = fakeClient({
      "mcp.list": () => ({
        servers: [
          { name: "local", command: "srv", args: [], enabled: true, status: "configured", source: "settings" },
          {
            name: "linear",
            command: "npx",
            args: ["-y", "mcp-remote"],
            enabled: true,
            status: "configured",
            source: "plugin",
            pluginId: "dev.miniq.linear",
            pluginName: "Linear",
            readOnly: true,
          },
        ],
      }),
      "mcp.update": () => ({}),
    });
    render(<McpPanel client={client} />);
    expect(await screen.findByText(/来自插件 Linear/)).toBeTruthy();
    // Only the settings server offers remove / toggle controls.
    expect(screen.getAllByText("移除")).toHaveLength(1);
    expect(document.querySelectorAll(".switch")).toHaveLength(1);

    fireEvent.click(document.querySelector(".switch") as Element);
    await waitFor(() => expect(call).toHaveBeenCalledWith("mcp.update", expect.anything()));
    const update = call.mock.calls.find(([method]) => method === "mcp.update")?.[1] as {
      servers: { name: string }[];
    };
    expect(update.servers.map((server) => server.name)).toEqual(["local"]);
  });
});
