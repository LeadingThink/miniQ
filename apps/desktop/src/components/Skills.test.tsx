// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { SkillsPanel } from "./Skills";
import { useSlashSkills } from "../hooks/useSlashSkills";
import { filterSlashCommands } from "../composerSlash";
import { skillDisplayName } from "../skillDisplay";
vi.mock("./ui/Toast", () => ({ useToast: () => vi.fn(), showUndoToast: vi.fn() }));
afterEach(cleanup);
const skill = { name: "frontend-polish", displayName: "前端界面打磨", description: "Refine frontend", enabled: true, version: 1, source: "bundled", origin: "bundled" };
function client() {
  const call = vi.fn(async (method: string) => method === "skill.list" ? { skills: [skill] } : { ...skill, body: "Body", files: [] });
  return { call } as unknown as RpcClient;
}
it("shows Chinese titles, finds both names, and reads/toggles using the stable ID", async () => {
  const rpc = client();
  render(<SkillsPanel client={rpc} workspaceId="workspace-1" />);
  await screen.findByText(skill.displayName);
  const search = screen.getByPlaceholderText("搜索任务、技能名称或描述");
  for (const text of ["界面打磨", "frontend-polish"]) {
    fireEvent.change(search, { target: { value: text } });
    expect(screen.getByText(skill.displayName)).toBeTruthy();
  }
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("skill.setEnabled", { name: skill.name, enabled: false }));
  fireEvent.click(screen.getByText(skill.displayName));
  await screen.findByText(`技能标识：${skill.name}`);
  expect(rpc.call).toHaveBeenCalledWith("skill.read", { name: skill.name, workspaceId: "workspace-1" });
});
it("localizes slash labels while inserting the original callable ID", async () => {
  const rpc = client();
  const { result } = renderHook(() => useSlashSkills(rpc, true));
  await waitFor(() => expect(result.current.commands).toHaveLength(1));
  expect(result.current.commands[0].name).toBe(skill.displayName);
  expect(result.current.commands[0].insertText).toBe(`使用技能「${skill.name}」：`);
  expect(filterSlashCommands(result.current.commands, "界面")).toHaveLength(1);
  expect(filterSlashCommands(result.current.commands, "frontend-polish")).toHaveLength(1);
});
it("keeps custom skills without display titles usable", () => {
  expect(skillDisplayName({ name: "custom" })).toBe("custom");
  expect(skillDisplayName({ name: "custom", displayName: "  " })).toBe("custom");
});
