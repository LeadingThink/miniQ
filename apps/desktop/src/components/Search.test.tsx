// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, Workspace } from "../types";
import { PALETTE_RECENT_KEY, SearchOverlay, type PaletteCommand } from "./Search";

const workspace: Workspace = {
  id: "w1",
  path: "/tmp/alpha",
  additionalPaths: [],
  name: "Alpha 项目",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function session(id: string, title: string, updatedAt: string): Session {
  return {
    id,
    workspaceId: "w1",
    workingDirectory: "/tmp/alpha",
    title,
    status: "idle",
    pinned: false,
    archived: false,
    createdAt: updatedAt,
    updatedAt,
  } as Session;
}

const sessions = [
  session("s1", "重构登录流程", "2024-03-02T00:00:00Z"),
  session("s2", "修复设置页崩溃", "2024-03-01T00:00:00Z"),
];

function setup(overrides: { commands?: PaletteCommand[] } = {}) {
  const onSelectSession = vi.fn();
  const onClose = vi.fn();
  const openSettings = vi.fn();
  const commands: PaletteCommand[] = overrides.commands ?? [
    { id: "settings", label: "打开设置", hint: "⌘,", icon: "settings", run: openSettings },
    { id: "new", label: "新建对话", icon: "new", run: vi.fn(), shortcut: "⌘N" },
  ];
  render(
    <SearchOverlay
      sessions={sessions}
      workspaces={[workspace]}
      commands={commands}
      onSelectSession={onSelectSession}
      onClose={onClose}
    />,
  );
  const input = screen.getByRole("combobox");
  return { input, onSelectSession, onClose, openSettings };
}

const activeOption = () => {
  const input = screen.getByRole("combobox");
  const id = input.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("is a labelled modal with commands and recent sessions when empty", () => {
  const { input } = setup();
  expect(screen.getByRole("dialog", { name: "搜索与命令" }).getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(input);
  const listbox = screen.getByRole("listbox");
  expect(within(listbox).getByText("命令")).toBeTruthy();
  expect(within(listbox).getByText("最近会话")).toBeTruthy();
  expect(within(listbox).getByText("⌘N").tagName).toBe("KBD");
  expect(activeOption()?.textContent).toContain("打开设置");
});

it("moves through options with arrow keys, wraps, and activates with Enter", () => {
  const { input, onSelectSession, onClose } = setup();
  const options = screen.getAllByRole("option");
  expect(options.length).toBe(4);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(activeOption()?.textContent).toContain("新建对话");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(activeOption()?.textContent).toContain("重构登录流程");
  expect(activeOption()?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(activeOption()?.textContent).toContain("修复设置页崩溃");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSelectSession).toHaveBeenCalledWith("s2");
  expect(JSON.parse(localStorage.getItem(PALETTE_RECENT_KEY) ?? "[]")).toEqual(["session:s2"]);
});

it("fuzzy filters across sections and resets the active item", () => {
  const { input, openSettings } = setup();
  fireEvent.change(input, { target: { value: "设置" } });
  const listbox = screen.getByRole("listbox");
  expect(within(listbox).getByText("命令")).toBeTruthy();
  expect(within(listbox).getByText("会话")).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(activeOption()?.textContent).toContain("打开设置");
  expect(listbox.querySelector("mark")?.textContent).toBe("设置");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(openSettings).toHaveBeenCalledOnce();
});

it("shows recently used entries first", () => {
  localStorage.setItem(PALETTE_RECENT_KEY, JSON.stringify(["cmd:new"]));
  setup();
  expect(screen.getByText("最近使用")).toBeTruthy();
  expect(activeOption()?.textContent).toContain("新建对话");
});

it("shows an empty state for no matches and closes on Escape", () => {
  const { input, onClose } = setup();
  fireEvent.change(input, { target: { value: "zzzzqq" } });
  expect(screen.getByRole("status").textContent).toContain("没有匹配的结果");
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});
