import { expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { buildPaletteCommands } from "./paletteCommands";

const app = (current?: { pinned: boolean }) => ({
  catalog: { currentSession: current },
  navigation: { sidebarCollapsed: false, openSettings: vi.fn(), setPage: vi.fn() },
}) as unknown as MiniqAppController;

it("routes commands through the shared runner with registry keycaps", () => {
  const run = vi.fn();
  const commands = buildPaletteCommands(app({ pinned: true }), run, true);
  const archive = commands.find((command) => command.id === "archiveSession")!;
  expect(archive.shortcut).toBe("⌘⇧A");
  archive.run();
  expect(run).toHaveBeenCalledWith("archiveSession");
  expect(commands.find((command) => command.id === "togglePin")!.label).toBe("取消置顶当前会话");
  expect(commands.find((command) => command.id === "copyMarkdown")!.shortcut).toBeUndefined();
  expect(commands.find((command) => command.id === "new-chat")!.shortcut).toBe("⌘N");
});

it("hides current-session actions without a session", () => {
  const ids = buildPaletteCommands(app(), vi.fn(), false).map((command) => command.id);
  expect(ids).not.toContain("archiveSession");
  expect(ids).toContain("showShortcuts");
});
