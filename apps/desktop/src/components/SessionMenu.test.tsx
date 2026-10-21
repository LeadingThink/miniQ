// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, Session } from "../types";
import { SessionMenu } from "./SessionMenu";

afterEach(cleanup);

const session = {
  id: "session-1",
  workspaceId: "workspace-1",
  workingDirectory: "/work",
  title: "重构上传流程",
  status: "idle",
  pinned: false,
  archived: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as Session;

const messages: Message[] = [
  { id: "u1", sessionId: session.id, role: "user", content: "改一下上传", createdAt: "2026-10-21T10:00:00Z" },
  { id: "a1", sessionId: session.id, role: "assistant", assistantKind: "final", content: "已完成上传重构", createdAt: "2026-10-21T10:01:00Z" },
  { id: "a2", sessionId: session.id, role: "assistant", assistantKind: "final", content: "补了重试逻辑", createdAt: "2026-10-21T10:02:00Z" },
];

function renderMenu(overrides: Partial<Parameters<typeof SessionMenu>[0]> = {}) {
  const props = {
    session,
    messages,
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onNewSideChat: vi.fn(),
    onFork: vi.fn(),
    onArchive: vi.fn(),
    ...overrides,
  };
  render(<SessionMenu {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
  return props;
}

describe("SessionMenu", () => {
  it("shows the session actions with shortcut hints", () => {
    renderMenu();
    expect(screen.getByText("重命名")).toBeTruthy();
    expect(screen.getByText("置顶")).toBeTruthy();
    expect(screen.getByText("新建侧边聊天")).toBeTruthy();
    expect(screen.getByText("分叉")).toBeTruthy();
    expect(screen.getByText("归档")).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Alt\+S|⌘⇧S/)).toBeTruthy();
  });

  it("forks from the newest reply through the submenu", () => {
    const props = renderMenu();
    fireEvent.click(screen.getByText("分叉"));
    expect(screen.getByText("从哪条回复分叉")).toBeTruthy();
    fireEvent.click(screen.getByText("补了重试逻辑"));
    expect(props.onFork).toHaveBeenCalledWith("a2");
  });

  it("renames inline and keeps the menu open until saved", async () => {
    const props = renderMenu();
    fireEvent.click(screen.getByText("重命名"));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "新标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(props.onRename).toHaveBeenCalledWith("新标题"));
  });
});
