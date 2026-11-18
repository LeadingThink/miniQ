// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { COMMAND_EVENT } from "../shortcuts";
import { AppMenuBar } from "./AppMenuBar";
import { listen } from "@tauri-apps/api/event";

const native = vi.hoisted(() => ({
  enabled: false,
  invoke: vi.fn(),
  handler: undefined as ((event: { payload: string }) => void) | undefined,
  create: vi.fn(),
  popup: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name, handler) => { native.handler = handler; return () => {}; }) }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => native.enabled }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: native.create } }));
vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
beforeEach(() => {
  native.enabled = false;
  native.handler = undefined;
  native.invoke.mockResolvedValue(undefined);
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
  expect(screen.getByText("创作、学习和探索")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitemradio", { name: /在问/ }));
  expect(onPlatformChange).toHaveBeenCalledWith("zaiwen");
});

it("opens the styled native overlay above child WebViews and keeps the current selection inert", async () => {
  native.enabled = true;
  const onPlatformChange = vi.fn();
  render(<AppMenuBar app={controller()} platform="zaiwen" onPlatformChange={onPlatformChange} />);
  const trigger = screen.getByRole("button", { name: "在问" });
  fireEvent.click(trigger);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("platform_overlay_open", {
    bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    snapshot: expect.objectContaining({ platform: "zaiwen", anchor: expect.any(Object), requestId: expect.any(String) }),
  }));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(native.create).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu", { name: "选择平台" })).toBeNull();
  await waitFor(() => expect(native.handler).toBeTypeOf("function"));
  await act(async () => native.handler?.({ payload: "zaiwen" }));
  expect(onPlatformChange).not.toHaveBeenCalled();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);
  await act(async () => native.handler?.({ payload: "miniq" }));
  expect(onPlatformChange).toHaveBeenCalledExactlyOnceWith("miniq");
});

it("opens the styled overlay from the keyboard and reports creation failures", async () => {
  native.enabled = true;
  native.invoke.mockRejectedValueOnce(new Error("overlay failed"));
  render(<AppMenuBar app={controller()} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "miniQ" }), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("overlay failed"));
  expect(screen.queryByRole("menu", { name: "选择平台" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "miniQ" }));
  await waitFor(() => expect(native.invoke.mock.calls.filter(([name]) => name === "platform_overlay_open")).toHaveLength(2));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the native action listener subscribed across parent updates and uses the latest callback", async () => {
  native.enabled = true;
  const initialChange = vi.fn();
  const latestChange = vi.fn();
  const view = render(<AppMenuBar app={controller()} onPlatformChange={initialChange} />);
  await waitFor(() => expect(native.handler).toBeTypeOf("function"));
  const subscriptions = vi.mocked(listen).mock.calls.length;
  view.rerender(<AppMenuBar app={controller()} onPlatformChange={latestChange} />);
  expect(vi.mocked(listen)).toHaveBeenCalledTimes(subscriptions);
  await act(async () => native.handler?.({ payload: "zaiwen" }));
  expect(initialChange).not.toHaveBeenCalled();
  expect(latestChange).toHaveBeenCalledExactlyOnceWith("zaiwen");
});

it("uses native popups for application menus", async () => {
  native.enabled = true;
  const app = controller();
  render(<AppMenuBar app={app} />);
  fireEvent.click(screen.getByRole("menuitem", { name: "文件" }));
  await waitFor(() => expect(native.popup).toHaveBeenCalledOnce());
  expect(screen.queryByRole("menu", { name: "文件" })).toBeNull();
  const items = native.create.mock.calls[0][0].items;
  await act(async () => items.find((item: { text: string }) => item.text === "打开项目文件夹…").action());
  expect(app.actions.openWorkspace).toHaveBeenCalledOnce();
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
  render(<AppMenuBar app={app} />);
  fireEvent.click(screen.getByRole("menuitem", { name: "文件" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "打开项目文件夹…" })); });
  expect(app.actions.openWorkspace).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("menuitem", { name: "视图" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "已安排" })); });
  expect(app.navigation.setPage).toHaveBeenCalledWith("schedule");
});
