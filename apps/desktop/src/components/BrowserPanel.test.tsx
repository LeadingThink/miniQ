// @vitest-environment jsdom
import { act, fireEvent, render, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserPanel, browserShortcut } from "./BrowserPanel";

const { load, action, command, invoke, openExternal, nativeListeners, hookArgs } = vi.hoisted(() => ({
  load: vi.fn(async () => {}),
  action: vi.fn(async () => {}),
  command: vi.fn(async () => null),
  invoke: vi.fn(async () => undefined),
  openExternal: vi.fn(async () => {}),
  nativeListeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  hookArgs: [] as unknown[][],
}));
const state = {
  address: "https://next.test/",
  zoom: 1,
  loadError: null as { url: string; code: string; message: string } | null,
};
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../externalLinks", () => ({ openExternalUrl: openExternal }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const set = nativeListeners.get(name) ?? new Set();
    set.add(handler);
    nativeListeners.set(name, set);
    return () => set.delete(handler);
  }),
}));
vi.mock("../hooks/useBrowserPanel", () => ({ useBrowserPanel: (...args: unknown[]) => {
  hookArgs.push(args);
  return {
    address: state.address, activeUrl: "https://first.test/", pending: false,
    loading: false, error: null, ...(state.loadError ? { loadError: state.loadError } : {}), editing: { current: false }, load,
    setAddress: vi.fn(), setError: vi.fn(), action, command, zoom: state.zoom, viewId: "view-1",
  };
} }));
beforeEach(() => {
  state.address = "https://next.test/";
  state.zoom = 1;
  state.loadError = null;
  hookArgs.length = 0;
  nativeListeners.clear();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const emit = (name: string, payload: unknown) =>
  act(() => nativeListeners.get(name)?.forEach((handler) => handler({ payload })));
const listening = (name: string) => waitFor(() => expect(nativeListeners.get(name)?.size).toBe(1));

it("explicitly navigates an automation-owned tab when the user submits a new address", () => {
  const onNavigate = vi.fn();
  const view = render(<BrowserPanel url="https://first.test/" browserSessionId="browser-owned" onNavigate={onNavigate} onClose={vi.fn()} />);
  fireEvent.submit(view.getByLabelText("网址").closest("form")!);
  expect(load).toHaveBeenCalledExactlyOnceWith("https://next.test/");
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("https://next.test/");
});

it("explicitly navigates a manual tab without relying on URL metadata effects", () => {
  const onNavigate = vi.fn();
  const view = render(<BrowserPanel url="https://first.test/" onNavigate={onNavigate} onClose={vi.fn()} />);
  fireEvent.submit(view.getByLabelText("网址").closest("form")!);
  expect(load).toHaveBeenCalledExactlyOnceWith("https://next.test/");
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("https://next.test/");
});

it("shows a navigation error center with retry details and the failed URL", () => {
  const loadError = {
    url: "https://failed.test/path?q=full-value#section",
    code: "ERR_NAME_NOT_RESOLVED",
    message: "无法解析主机名 failed.test",
  };
  state.loadError = loadError;
  const view = render(<BrowserPanel url="https://first.test/" onNavigate={vi.fn()} onClose={vi.fn()} />);

  expect(view.getByRole("heading", { name: "无法访问此站点" })).toBeTruthy();
  expect(view.getByText(loadError.url)).toBeTruthy();
  expect(view.getByText(loadError.message)).toBeTruthy();
  expect(view.getByText(loadError.code)).toBeTruthy();
  expect(view.getByText("加载失败")).toBeTruthy();
  expect(view.getByLabelText("网页加载错误").querySelector("iframe")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "重试" }));
  expect(load).toHaveBeenCalledExactlyOnceWith(loadError.url);
  fireEvent.click(view.getByRole("button", { name: "在系统浏览器中打开" }));
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(loadError.url);
});

it.each([
  ["rust 教程", `https://www.bing.com/search?q=${encodeURIComponent("rust 教程")}`],
  ["localhost:5173", "http://localhost:5173/"],
])("resolves address bar input %s", (address, expected) => {
  state.address = address;
  const view = render(<BrowserPanel url="https://first.test/" onNavigate={vi.fn()} onClose={vi.fn()} />);
  fireEvent.submit(view.getByLabelText("网址").closest("form")!);
  expect(load).toHaveBeenCalledExactlyOnceWith(expected);
});

it("reports page titles and opens page popups as new tabs for its own view only", async () => {
  const onTitle = vi.fn();
  const onOpenWindow = vi.fn();
  render(<BrowserPanel url="https://first.test/" onNavigate={vi.fn()} onClose={vi.fn()} onTitle={onTitle} onOpenWindow={onOpenWindow} />);
  await listening("browser://title");
  await listening("browser://new-window");
  emit("browser://title", { viewId: "other", title: "Other" });
  emit("browser://title", { viewId: "view-1", title: "首页 - Example" });
  expect(onTitle).toHaveBeenCalledExactlyOnceWith("首页 - Example");
  emit("browser://new-window", { viewId: "other", url: "https://x.test/" });
  emit("browser://new-window", { viewId: "view-1", url: "javascript:alert(1)" });
  emit("browser://new-window", { viewId: "view-1", url: "https://popup.test/login" });
  expect(onOpenWindow).toHaveBeenCalledExactlyOnceWith("https://popup.test/login");
});

it("lists downloads with their state and reveals finished files", async () => {
  const view = render(<BrowserPanel url="https://first.test/" onNavigate={vi.fn()} onClose={vi.fn()} />);
  await listening("browser://download");
  const base = { viewId: "view-1", id: "d1", url: "https://first.test/a.pdf", fileName: "a.pdf", path: "" };
  emit("browser://download", { ...base, phase: "started" });
  emit("browser://download", { ...base, id: "d2", fileName: "b.zip", phase: "started" });
  const list = () => view.getByRole("region", { name: "下载" });
  expect(list().textContent).toContain("a.pdf");
  expect(list().textContent).toContain("下载中");
  expect(view.queryByRole("button", { name: /在访达中显示|在资源管理器中显示|在文件管理器中显示/ })).toBeNull();
  emit("browser://download", { ...base, path: "/Users/me/Downloads/a.pdf", phase: "finished" });
  emit("browser://download", { ...base, id: "d2", fileName: "b.zip", phase: "failed" });
  expect(list().querySelectorAll("li")).toHaveLength(2);
  expect(list().textContent).toContain("已完成");
  expect(list().textContent).toContain("失败");
  fireEvent.click(view.getByRole("button", { name: /在(访达|资源管理器|文件管理器)中显示 a\.pdf/ }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("browser_reveal_download", { path: "/Users/me/Downloads/a.pdf" }));
  fireEvent.click(view.getByRole("button", { name: "从下载列表移除 b.zip" }));
  expect(list().querySelectorAll("li")).toHaveLength(1);
});

it("shows a short notice when a link was handed to the system", async () => {
  const view = render(<BrowserPanel url="https://first.test/" onNavigate={vi.fn()} onClose={vi.fn()} />);
  await listening("browser://external");
  emit("browser://external", { viewId: "view-1", url: "mailto:hi@example.com" });
  expect(view.getByText("已用系统应用打开 mailto:hi@example.com")).toBeTruthy();
});

it("runs zoom, print and devtools from the more menu and hides the native page meanwhile", async () => {
  state.zoom = 1.25;
  const view = render(<BrowserPanel url="https://first.test/" onNavigate={vi.fn()} onClose={vi.fn()} />);
  expect(hookArgs.at(-1)![2]).toBe(false);
  const more = view.getByRole("button", { name: "更多浏览器操作" });
  fireEvent.click(more);
  expect(hookArgs.at(-1)![2]).toBe(true);
  const menu = view.getByRole("menu", { name: "更多浏览器操作" });
  expect(menu.textContent).toContain("实际大小（125%）");
  fireEvent.click(view.getByRole("menuitem", { name: /放大/ }));
  expect(command).toHaveBeenLastCalledWith("zoom_in");
  expect(view.queryByRole("menu")).toBeNull();
  for (const [label, name] of [[/缩小/, "zoom_out"], [/实际大小/, "zoom_reset"], [/打印/, "print"], [/开发者工具/, "devtools"]] as const) {
    fireEvent.click(more);
    fireEvent.click(view.getByRole("menuitem", { name: label }));
    expect(command).toHaveBeenLastCalledWith(name);
  }
});

it("clears browsing data only after confirmation and reports the result", async () => {
  const view = render(<BrowserPanel url="https://first.test/" onNavigate={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(view.getByRole("button", { name: "更多浏览器操作" }));
  fireEvent.click(view.getByRole("menuitem", { name: /清除浏览数据/ }));
  expect(command).not.toHaveBeenCalled();
  const dialog = view.getByRole("alertdialog");
  expect(hookArgs.at(-1)![2]).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "取消" }));
  expect(view.queryByRole("alertdialog")).toBeNull();
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "更多浏览器操作" }));
  fireEvent.click(view.getByRole("menuitem", { name: /清除浏览数据/ }));
  fireEvent.click(view.getByRole("button", { name: "清除" }));
  expect(dialog).toBeTruthy();
  await waitFor(() => expect(view.getByText("已清除浏览数据")).toBeTruthy());
  expect(command).toHaveBeenCalledExactlyOnceWith("clear_data");
});

it("handles browser shortcuts only while focus is inside the browser panel", () => {
  const view = render(<>
    <textarea aria-label="聊天输入" />
    <BrowserPanel url="https://first.test/" onNavigate={vi.fn()} onClose={vi.fn()} />
  </>);
  const composer = view.getByLabelText("聊天输入");
  const outside = fireEvent.keyDown(composer, { key: "r", code: "KeyR", metaKey: true });
  fireEvent.keyDown(composer, { key: "p", code: "KeyP", ctrlKey: true });
  expect(outside).toBe(true);
  expect(action).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();

  const address = view.getByLabelText("网址");
  const windowSaw = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
  window.addEventListener("keydown", windowSaw);
  expect(fireEvent.keyDown(address, { key: "r", code: "KeyR", metaKey: true })).toBe(false);
  expect(action).toHaveBeenLastCalledWith("reload");
  fireEvent.keyDown(address, { key: "[", code: "BracketLeft", metaKey: true });
  expect(action).toHaveBeenLastCalledWith("back");
  fireEvent.keyDown(address, { key: "]", code: "BracketRight", ctrlKey: true });
  expect(action).toHaveBeenLastCalledWith("forward");
  fireEvent.keyDown(address, { key: "=", code: "Equal", metaKey: true });
  expect(command).toHaveBeenLastCalledWith("zoom_in");
  fireEvent.keyDown(address, { key: "-", code: "Minus", metaKey: true });
  expect(command).toHaveBeenLastCalledWith("zoom_out");
  fireEvent.keyDown(address, { key: "0", code: "Digit0", ctrlKey: true });
  expect(command).toHaveBeenLastCalledWith("zoom_reset");
  fireEvent.keyDown(view.getByRole("button", { name: "刷新" }), { key: "p", code: "KeyP", metaKey: true });
  expect(command).toHaveBeenLastCalledWith("print");
  window.removeEventListener("keydown", windowSaw);
  // App-wide shortcuts (e.g. ⌘P quick open) never run for handled keys.
  expect(windowSaw).not.toHaveBeenCalled();
});

it("maps shortcut keys, including shifted plus", () => {
  const base = { code: "", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
  expect(browserShortcut({ ...base, key: "+", shiftKey: true, code: "Equal" })).toBe("zoom_in");
  expect(browserShortcut({ ...base, key: "r", shiftKey: true })).toBeNull();
  expect(browserShortcut({ ...base, key: "r", metaKey: false })).toBeNull();
  expect(browserShortcut({ ...base, key: "r", altKey: true })).toBeNull();
  expect(browserShortcut({ ...base, key: "l" })).toBeNull();
});
