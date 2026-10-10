// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { ExtensionCenter } from "./ExtensionCenter";
vi.mock("./Skills", () => ({ SkillsPanel: () => <div>技能目录</div> }));
vi.mock("./Mcp", () => ({
  McpPanel: ({ onManagePlugins }: { onManagePlugins: () => void }) => (
    <button onClick={onManagePlugins}>管理来源扩展包</button>
  ),
}));
vi.mock("./Plugins", () => ({ PluginsPanel: () => <div>扩展包目录</div> }));
afterEach(cleanup);
const client = {} as RpcClient;
it("switches sections through buttons and keyboard and returns to the conversation", () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <ExtensionCenter
      client={client}
      workspaceId={null}
      selected="skills"
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  expect(
    screen.getByRole("tab", { name: "技能" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("tabpanel").textContent).toContain("技能目录");
  fireEvent.click(screen.getByRole("tab", { name: "连接器" }));
  expect(onSelect).toHaveBeenLastCalledWith("mcp");
  fireEvent.keyDown(screen.getByRole("tab", { name: "技能" }), { key: "End" });
  expect(onSelect).toHaveBeenLastCalledWith("plugins");
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "扩展包" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
  expect(onClose).toHaveBeenCalledOnce();
});
it("opens extension management from a plugin connector", () => {
  const onSelect = vi.fn();
  render(
    <ExtensionCenter
      client={client}
      workspaceId={null}
      selected="mcp"
      onSelect={onSelect}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "管理来源扩展包" }));
  expect(onSelect).toHaveBeenCalledWith("plugins");
});
