// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { COMMAND_EVENT } from "../shortcuts";
import { AppMenuBar } from "./AppMenuBar";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function controller() {
  return {
    catalog: { currentSession: null }, client: { mode: "local" },
    navigation: { sidebarCollapsed: false, setPage: vi.fn(), setShowExternalImport: vi.fn() },
    actions: { openWorkspace: vi.fn() }, updater: { supported: true, checkNow: vi.fn() }, setError: vi.fn(),
  } as unknown as MiniqAppController;
}

it("runs menu commands once through the shared bus and closes the dropdown", async () => {
  render(<AppMenuBar app={controller()} />);
  const commands = vi.fn();
  window.addEventListener(COMMAND_EVENT, commands);
  try {
    fireEvent.click(screen.getByRole("menuitem", { name: "文件" }));
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /新对话/ })); });
    expect(commands).toHaveBeenCalledOnce();
    expect(commands.mock.calls[0][0].detail).toEqual({ id: "newChat" });
    expect(screen.queryByRole("menu")).toBeNull();
  } finally { window.removeEventListener(COMMAND_EVENT, commands); }
});

it("switches menus with hover and arrow keys, and Escape returns focus", () => {
  render(<AppMenuBar app={controller()} />);
  fireEvent.click(screen.getByRole("menuitem", { name: "文件" }));
  fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "编辑" }));
  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
  expect(screen.getByRole("menu", { name: "编辑" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu", { name: "编辑" }), { key: "ArrowRight" });
  expect(screen.getByRole("menu", { name: "视图" })).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "视图" }));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("supports keyboard entry, outside dismissal, and unavailable session actions", () => {
  render(<AppMenuBar app={controller()} />);
  const file = screen.getByRole("menuitem", { name: "文件" });
  act(() => file.focus());
  fireEvent.keyDown(file, { key: "ArrowRight" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  const menu = screen.getByRole("menu", { name: "编辑" });
  expect((within(menu).getByRole("menuitem", { name: /搜索当前会话/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("restores the original input selection before applying an edit", async () => {
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
  render(<><textarea aria-label="草稿" defaultValue="hello miniQ" /><AppMenuBar app={controller()} /></>);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  act(() => { input.focus(); input.setSelectionRange(6, 11); });
  const edit = screen.getByRole("menuitem", { name: "编辑" });
  fireEvent.mouseDown(edit);
  fireEvent.click(edit);
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /^复制\s*Ctrl\+C$/ })); });
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([6, 11]);
  expect(execCommand).toHaveBeenCalledWith("copy");
});

it("opens the about dialog after menu focus restoration", async () => {
  render(<AppMenuBar app={controller()} />);
  fireEvent.click(screen.getByRole("menuitem", { name: "帮助" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "关于 miniQ" })); });
  const dialog = screen.getByRole("dialog", { name: "关于 miniQ" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens project and page actions using the active controller", async () => {
  const app = controller();
  render(<AppMenuBar app={app} />);
  fireEvent.click(screen.getByRole("menuitem", { name: "文件" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "打开项目文件夹…" })); });
  expect(app.actions.openWorkspace).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("menuitem", { name: "视图" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "已安排" })); });
  expect(app.navigation.setPage).toHaveBeenCalledWith("schedule");
});
