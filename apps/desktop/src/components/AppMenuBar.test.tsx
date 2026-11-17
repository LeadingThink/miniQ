// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { COMMAND_EVENT } from "../shortcuts";
import { AppMenuBar } from "./AppMenuBar";

const native = vi.hoisted(() => ({
  enabled: false,
  create: vi.fn(),
  popup: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
vi.mock("../runtime", () => ({ isTauriRuntime: () => native.enabled }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: native.create } }));
vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
beforeEach(() => {
  native.enabled = false;
  vi.clearAllMocks();
  native.create.mockResolvedValue({ popup: native.popup, close: native.close });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function controller() {
  return {
    catalog: { currentSession: null }, client: { mode: "local" },
    navigation: { sidebarCollapsed: false, setPage: vi.fn(), setShowExternalImport: vi.fn() },
    actions: { openWorkspace: vi.fn() }, updater: { supported: true, checkNow: vi.fn() }, setError: vi.fn(),
  } as unknown as MiniqAppController;
}

it("keeps the sidebar toggle out of the top menu bar", () => {
  render(<AppMenuBar app={controller()} />);
  expect(screen.queryByRole("button", { name: "隐藏侧栏" })).toBeNull();
  expect(screen.queryByRole("button", { name: "显示侧栏" })).toBeNull();
});

it("offers the miniQ and 在问 platform switcher", () => {
  const onPlatformChange = vi.fn();
  render(<AppMenuBar app={controller()} onPlatformChange={onPlatformChange} />);
  fireEvent.click(screen.getByRole("button", { name: /miniQ/ }));
  expect(screen.getByRole("menu", { name: "选择平台" })).toBeTruthy();
  expect(screen.getByText("查看在问账号的会话")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitemradio", { name: /在问/ }));
  expect(onPlatformChange).toHaveBeenCalledWith("zaiwen");
});

it("uses the same two-line platform menu on desktop and keeps the current platform selection inert", () => {
  native.enabled = true;
  const onPlatformChange = vi.fn();
  render(<AppMenuBar app={controller()} platform="zaiwen" zaiwenUser="user" onPlatformChange={onPlatformChange} />);
  fireEvent.click(screen.getByRole("button", { name: /在问/ }));
  const menu = screen.getByRole("menu", { name: "选择平台" });
  const current = within(menu).getByRole("menuitemradio", { name: "在问", description: "查看在问账号的会话" });
  expect(current.getAttribute("aria-checked")).toBe("true");
  expect(current.querySelector("strong")?.textContent).toBe("在问");
  expect(current.querySelector("small")?.textContent).toBe("查看在问账号的会话");
  expect(within(menu).getByText("已登录：user")).toBeTruthy();
  expect(screen.queryByText("在问主站")).toBeNull();
  expect(native.create).not.toHaveBeenCalled();
  fireEvent.click(current);
  expect(onPlatformChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu", { name: "选择平台" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "在问" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /miniQ/ }));
  expect(onPlatformChange).toHaveBeenCalledExactlyOnceWith("miniq");
  expect(screen.queryByRole("menu", { name: "选择平台" })).toBeNull();
});

it("uses native popups for application menus", async () => {
  native.enabled = true;
  const app = controller();
  const onNavigate = vi.fn();
  render(<AppMenuBar app={app} platform="zaiwen" onNavigate={onNavigate} />);
  fireEvent.click(screen.getByRole("menuitem", { name: "文件" }));
  await waitFor(() => expect(native.popup).toHaveBeenCalledOnce());
  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
  const items = native.create.mock.calls[0][0].items;
  await act(async () => items.find((item: { text: string }) => item.text === "打开项目文件夹…").action());
  expect(app.actions.openWorkspace).toHaveBeenCalledOnce();
  expect(onNavigate).toHaveBeenCalledOnce();
});

it("navigates platform choices with the keyboard and closes on Escape and outside clicks", () => {
  render(<AppMenuBar app={controller()} />);
  const trigger = screen.getByRole("button", { name: /miniQ/ });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const cloud = screen.getByRole("menuitemradio", { name: /在问/ });
  const local = screen.getByRole("menuitemradio", { name: /miniQ/ });
  expect(document.activeElement).toBe(cloud);
  fireEvent.keyDown(cloud, { key: "ArrowDown" });
  expect(document.activeElement).toBe(local);
  fireEvent.keyDown(local, { key: "ArrowDown" });
  expect(document.activeElement).toBe(cloud);
  fireEvent.keyDown(cloud, { key: "End" });
  expect(document.activeElement).toBe(local);
  fireEvent.keyDown(local, { key: "Home" });
  expect(document.activeElement).toBe(cloud);
  fireEvent.keyDown(cloud, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "选择平台" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu", { name: "选择平台" })).toBeNull();
});

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
  const onNavigate = vi.fn();
  render(<AppMenuBar app={app} onNavigate={onNavigate} />);
  fireEvent.click(screen.getByRole("menuitem", { name: "文件" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "打开项目文件夹…" })); });
  expect(app.actions.openWorkspace).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("menuitem", { name: "视图" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "已安排" })); });
  expect(app.navigation.setPage).toHaveBeenCalledWith("schedule");
  expect(onNavigate).toHaveBeenCalledTimes(2);
});
