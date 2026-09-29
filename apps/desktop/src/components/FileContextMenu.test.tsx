// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { COMPOSER_INSERT_EVENT } from "../fileActions";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import { PreviewOptionsMenu } from "./PreviewOptionsMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const listing = (path: string, entries: { path: string; directory: boolean }[]) => ({
  path,
  entries: entries.map((item) => ({ ...item, name: item.path.split("/").at(-1)!, size: 1 })),
  nextCursor: null,
  roots: ["/p"],
});

async function renderTree(mode: "local" | "remote") {
  const call = vi.fn(async () =>
    listing("/p", [
      { path: "/p/my notes.md", directory: false },
      { path: "/p/src", directory: true },
    ]),
  );
  const onOpen = vi.fn();
  render(
    <WorkspaceFileTree
      access={{ client: { call, mode } as never, sessionId: "s1" }}
      onOpen={onOpen}
      activePath={null}
    />,
  );
  await screen.findByRole("treeitem", { name: /src/ });
  return { onOpen };
}

const itemNames = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

it("opens a file context menu on right click with add-to-chat and open actions", async () => {
  const { onOpen } = await renderTree("local");
  const file = screen.getByRole("treeitem", { name: /my notes/ });
  fireEvent.contextMenu(file, { clientX: 20, clientY: 30 });
  // Browser (non-Tauri) runtime hides Finder and external editor items.
  expect(itemNames()).toEqual(["打开", "添加到聊天", "复制路径", "复制相对路径"]);
  const listener = vi.fn();
  window.addEventListener(COMPOSER_INSERT_EVENT, listener);
  fireEvent.click(screen.getByRole("menuitem", { name: "添加到聊天" }));
  window.removeEventListener(COMPOSER_INSERT_EVENT, listener);
  expect((listener.mock.calls[0][0] as CustomEvent).detail.text).toBe("@`my notes.md` ");
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.keyDown(file, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "打开" }));
  expect(onOpen).toHaveBeenCalledWith("/p/my notes.md");
});

it("shows Finder and editor items for local desktop sessions only", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  await renderTree("local");
  fireEvent.keyDown(screen.getByRole("treeitem", { name: /src/ }), { key: "ContextMenu" });
  expect(itemNames()).toEqual(["添加到聊天", "在 Finder 中显示", "复制路径", "复制相对路径"]);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: /my notes/ }));
  expect(itemNames()).toContain("用 VS Code 打开");
  expect(itemNames()).toContain("在 Finder 中显示");
  cleanup();
  await renderTree("remote");
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: /my notes/ }));
  expect(itemNames()).not.toContain("在 Finder 中显示");
  expect(itemNames()).not.toContain("用 VS Code 打开");
});

it("preview options copy relative paths and gate editor actions", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const onFind = vi.fn();
  render(
    <PreviewOptionsMenu path="/p/src/a.ts" roots={["/p"]} content={null} onFind={onFind} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "更多文件操作" }));
  expect(screen.getByRole("menuitem", { name: /复制文件内容/ })).toHaveProperty("disabled", true);
  expect(screen.getByRole("menuitem", { name: /转到行/ })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("menuitem", { name: /在 Finder 中显示/ })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "复制相对路径" }));
  });
  expect(writeText).toHaveBeenCalledWith("src/a.ts");
  fireEvent.click(screen.getByRole("button", { name: "更多文件操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /在文件中查找/ }));
  expect(onFind).toHaveBeenCalled();
});
