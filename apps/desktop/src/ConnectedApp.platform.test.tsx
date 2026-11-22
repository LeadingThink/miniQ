// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import ConnectedApp from "./ConnectedApp";
import { browserAction, closeBrowser, openBrowser, resizeBrowser, setBrowserVisible } from "./browserWorkbench";
import { isTauriRuntime } from "./runtime";
import { openLinkWindow } from "./linkActions";
import type { PlatformOverlaySnapshot } from "./platformOverlay";
import PlatformOverlay from "./components/PlatformOverlay";

const state = vi.hoisted(() => ({
  mount: vi.fn(), unmount: vi.fn(), host: null as string | null,
  invoke: vi.fn(), status: vi.fn(), keys: vi.fn(), save: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  root: { mode: "local", call: vi.fn() },
  controller: {
    client: { mode: "local" }, catalog: {}, setError: vi.fn(),
    navigation: {}, actions: {}, updater: {}, connection: { refreshProviderConfiguration: vi.fn(async () => true) },
  },
}));
vi.mock("./zaiwenKeyImport", async (original) => ({ ...await original<typeof import("./zaiwenKeyImport")>(),
  zaiwenSessionStatus: state.status, loadZaiwenImportKeys: state.keys, importZaiwenKey: state.save,
}));
vi.mock("./runtime", () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock("./desktopHost", () => ({ useDesktopHost: () => ({ host: state.host, sidebarCollapsed: false, root: state.root }) }));
vi.mock("./hooks/useMiniqApp", () => ({ useMiniqApp: () => state.controller }));
vi.mock("./components/UnifiedSidebar", () => ({ UnifiedSidebar: () => <aside aria-label="miniQ 会话" /> }));
vi.mock("./components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("./components/AppShell", () => ({ AppShell: ({ active }: { active: boolean }) => {
  useEffect(() => { state.mount(); return state.unmount; }, []);
  return <section aria-label="miniQ 工作台" data-active={String(active)}><input aria-label="本地草稿" /></section>;
} }));
vi.mock("./linkActions", () => ({ openLinkWindow: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  state.listeners.set(name, handler);
  return () => state.listeners.delete(name);
}) }));
vi.mock("./browserWorkbench", async (original) => ({
  ...await original<typeof import("./browserWorkbench")>(),
  openBrowser: vi.fn(async (url: string) => ({ url })),
  closeBrowser: vi.fn(async () => {}),
  resizeBrowser: vi.fn(async () => {}),
  setBrowserVisible: vi.fn(async () => {}),
  currentBrowser: vi.fn(async () => null),
  browserAction: vi.fn(async () => null),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.invoke.mockResolvedValue(undefined);
  state.host = null;
  state.status.mockResolvedValue({ supported: true, sessionId: null });
  state.root.call.mockResolvedValue({ provider: null });
  state.keys.mockReset().mockResolvedValue([{ key_id: "test-key", sk: "sk-private-test-key", remark: "工作密钥", is_active: true, expire_time: 4102444800 }]);
  state.save.mockResolvedValue(undefined);
  state.listeners.clear();
  localStorage.clear();
  delete window.__MINIQ_PLATFORM__;
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    return { x: 0, y: 44, width: 1200, height: 756, top: 44, left: 0, right: 1200, bottom: 800, toJSON: () => ({}) };
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("miniQ must not request main-site conversations"); }));
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openPlatformMenu() {
  const before = state.invoke.mock.calls.filter(([name]) => name === "platform_overlay_open").length;
  fireEvent.click(screen.getByRole("button", { name: /^(miniQ|在问)$/ }));
  await waitFor(() => expect(state.invoke.mock.calls.filter(([name]) => name === "platform_overlay_open")).toHaveLength(before + 1));
  const call = state.invoke.mock.calls.filter(([name]) => name === "platform_overlay_open").at(-1)!;
  return call[1].snapshot as PlatformOverlaySnapshot;
}

async function selectNativePlatform(_snapshot: PlatformOverlaySnapshot, name: "在问" | "miniQ") {
  await waitFor(() => expect(state.listeners.has("platform-overlay://action")).toBe(true));
  await act(async () => state.listeners.get("platform-overlay://action")!({ payload: name === "在问" ? "zaiwen" : "miniq" }));
}

async function switchTo(name: "在问" | "miniQ") {
  if (isTauriRuntime()) {
    await selectNativePlatform(await openPlatformMenu(), name);
    return;
  }
  fireEvent.click(screen.getByRole("button", { name: name === "在问" ? "miniQ" : "在问" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

async function finishSiteLoad() {
  await waitFor(() => expect(state.listeners.has("browser://page-load")).toBe(true));
  await act(async () => state.listeners.get("browser://page-load")!({ payload: {
    viewId: "zaiwen-site", url: "https://chat.zaiwenai.com/", phase: "finished",
  } }));
}

it.each(["Win32", "MacIntel", "Linux x86_64"])("opens the full main site immediately without a miniQ login or conversation list on %s", async (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const { container } = render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  const draft = screen.getByRole<HTMLInputElement>("textbox", { name: "本地草稿" });
  fireEvent.change(draft, { target: { value: "保留我的本地草稿" } });
  expect(openBrowser).not.toHaveBeenCalled();
  await switchTo("在问");
  await screen.findByRole("main", { name: "在问主站" });
  expect(screen.queryByRole("button", { name: "选择在问 API Key" })).toBeNull();
  expect(container.querySelector(".app-menubar-platform-actions")).toBeNull();
  await waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
  const [, bounds, viewId, visible] = vi.mocked(openBrowser).mock.calls[0];
  expect(viewId).toBe("zaiwen-site");
  expect(openBrowser).toHaveBeenCalledWith("https://chat.zaiwenai.com/", bounds, viewId, false);
  expect(bounds).toEqual({ x: 0, y: 44, width: 1200, height: 756 });
  expect(visible).toBe(false);
  expect(resizeBrowser).toHaveBeenCalledWith(bounds, viewId);
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, true));
  expect(container.querySelector(".app")?.getAttribute("inert")).toBe("");
  expect(screen.queryByRole("complementary", { name: "miniQ 会话" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "本地草稿" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
  expect(state.mount).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("miniQ 工作台").getAttribute("data-active")).toBe("false");
  expect(fetch).not.toHaveBeenCalled();

  const page = screen.getByRole("main", { name: "在问主站" });
  const visibilityChanges = vi.mocked(setBrowserVisible).mock.calls.length;
  const items = await openPlatformMenu();
  expect(screen.queryByRole("menu", { name: "选择平台" })).toBeNull();
  expect(setBrowserVisible).toHaveBeenCalledTimes(visibilityChanges);
  await selectNativePlatform(items, "在问");
  expect(setBrowserVisible).toHaveBeenCalledTimes(visibilityChanges);
  expect(screen.getByRole("main", { name: "在问主站" })).toBe(page);
  expect(openBrowser).toHaveBeenCalledOnce();
  expect(browserAction).not.toHaveBeenCalled();

  await switchTo("miniQ");
  expect(screen.queryByRole("button", { name: "选择在问 API Key" })).toBeNull();
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, false));
  expect(screen.queryByRole("main", { name: "在问主站" })).toBeNull();
  expect(screen.getByRole("complementary", { name: "miniQ 会话" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "本地草稿" })).toBe(draft);
  expect(draft.value).toBe("保留我的本地草稿");
  expect(screen.getByLabelText("miniQ 工作台").getAttribute("data-active")).toBe("true");
  expect(closeBrowser).not.toHaveBeenCalled();
  expect(state.unmount).not.toHaveBeenCalled();

  await switchTo("在问");
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, true));
  expect(screen.getByRole("main", { name: "在问主站" })).toBe(page);
  expect(openBrowser).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps the chosen SSH workspace mounted while the site is visible", async () => {
  state.host = "ssh-host";
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  const draft = screen.getByRole<HTMLInputElement>("textbox", { name: "本地草稿" });
  fireEvent.change(draft, { target: { value: "服务器上的草稿" } });
  await switchTo("在问");
  await screen.findByRole("main", { name: "在问主站" });
  expect(screen.getAllByLabelText("miniQ 工作台").every((node) => node.getAttribute("data-active") === "false")).toBe(true);
  await switchTo("miniQ");
  expect(screen.getByRole("textbox", { name: "本地草稿" })).toBe(draft);
  expect(draft.value).toBe("服务器上的草稿");
  expect(state.mount).toHaveBeenCalledTimes(2);
  expect(state.unmount).not.toHaveBeenCalled();
});

it("switches both ways through real overlay clicks, the IPC bridge and main-window events", async () => {
  state.invoke.mockImplementation(async (command: string, args: { action?: string }) => {
    if (command === "platform_overlay_action") {
      state.listeners.get("platform-overlay://action")?.({ payload: args.action });
    }
  });
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  window.__MINIQ_PLATFORM__ = await openPlatformMenu();
  const siteMenu = render(<PlatformOverlay />);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "在问" }));
  await screen.findByRole("main", { name: "在问主站" });
  await waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
  const viewId = vi.mocked(openBrowser).mock.calls[0][2];
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, true));
  siteMenu.unmount();

  window.__MINIQ_PLATFORM__ = await openPlatformMenu();
  const miniqMenu = render(<PlatformOverlay />);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "miniQ" }));
  await screen.findByRole("textbox", { name: "本地草稿" });
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, false));
  expect(state.invoke.mock.calls.filter(([name]) => name === "platform_overlay_action")).toEqual([
    ["platform_overlay_action", { action: "zaiwen" }],
    ["platform_overlay_action", { action: "miniq" }],
  ]);
  expect(openBrowser).toHaveBeenCalledOnce();
  expect(closeBrowser).not.toHaveBeenCalled();
  miniqMenu.unmount();
});

it("keeps the main site visible throughout native menu cancellation", async () => {
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  await switchTo("在问");
  await waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
  const viewId = vi.mocked(openBrowser).mock.calls[0][2];
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, true));
  const visibilityChanges = vi.mocked(setBrowserVisible).mock.calls.length;
  await openPlatformMenu();
  expect(setBrowserVisible).toHaveBeenCalledTimes(visibilityChanges);
  expect(screen.getByRole("main", { name: "在问主站" })).toBeTruthy();
  await act(async () => state.listeners.get("platform-overlay://action")!({ payload: "close" }));
  await waitFor(() => expect(state.invoke).toHaveBeenCalledWith("platform_overlay_close", {}));
  expect(setBrowserVisible).toHaveBeenCalledTimes(visibilityChanges);
  expect(screen.getByRole("button", { name: "在问" })).toBeTruthy();
  expect(openBrowser).toHaveBeenCalledOnce();
  expect(closeBrowser).not.toHaveBeenCalled();
});

it("renders the actual main-site page in web preview and preserves the frame on return", async () => {
  vi.mocked(isTauriRuntime).mockReturnValue(false);
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  await switchTo("在问");
  await waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
  await act(async () => {});
  const frame = await screen.findByTitle("在问主站网页");
  expect(frame.getAttribute("src")).toBe("https://chat.zaiwenai.com/");
  await switchTo("miniQ");
  await switchTo("在问");
  expect(screen.getByTitle("在问主站网页")).toBe(frame);
  expect(fetch).not.toHaveBeenCalled();
});

it("reports native page failures and retries the failed site URL", async () => {
  vi.mocked(openBrowser).mockResolvedValueOnce({ url: "https://chat.zaiwenai.com/", loadError: { code: "OFFLINE", message: "网络不可用" } });
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  await switchTo("在问");
  await screen.findByText("无法打开在问主站");
  expect(screen.getByRole("alert").textContent).toContain("网络不可用");
  expect(screen.getByRole("alert").textContent).toContain("OFFLINE");
  fireEvent.click(screen.getByRole("button", { name: "重试打开在问" }));
  await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(2));
  expect(vi.mocked(openBrowser).mock.calls[1][0]).toBe("https://chat.zaiwenai.com/");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("opens main-site popup links and closes the native surface when the app unmounts", async () => {
  const { unmount } = render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  await switchTo("在问");
  await waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
  const viewId = vi.mocked(openBrowser).mock.calls[0][2];
  await waitFor(() => expect(state.listeners.has("browser://new-window")).toBe(true));
  await act(async () => state.listeners.get("browser://new-window")!({ payload: { viewId, url: "https://chat.zaiwenai.com/help" } }));
  expect(openLinkWindow).toHaveBeenCalledExactlyOnceWith("https://chat.zaiwenai.com/help");
  unmount();
  await waitFor(() => expect(closeBrowser).toHaveBeenCalledExactlyOnceWith(viewId));
});

it.each(["Win32", "MacIntel"])("prompts on miniQ immediately after leaving a logged-in site on %s", async (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  state.status.mockResolvedValue({ supported: true, sessionId: "session-a" });
  let finish!: (keys: unknown[]) => void;
  state.keys.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  expect(state.status).not.toHaveBeenCalled();
  await switchTo("在问");
  await finishSiteLoad();
  await waitFor(() => expect(state.status).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.keys).not.toHaveBeenCalled();
  await switchTo("miniQ");
  expect(screen.getByRole("dialog", { name: "选择 API Key" })).toBeTruthy();
  expect(screen.getByLabelText("miniQ 工作台").getAttribute("data-active")).toBe("true");
  expect(screen.getByText("正在加载 API Key…")).toBeTruthy();
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith("zaiwen-site", false));
  await act(async () => finish([]));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await switchTo("在问");
  await switchTo("miniQ");
  await screen.findByRole("radio", { name: /工作密钥/ });
  expect(state.keys).toHaveBeenCalledTimes(2);
});

it.each([
  { supported: true, sessionId: null, provider: null },
  { supported: true, sessionId: "session-a", provider: { hasApiKey: true, baseUrl: "https://custom.test/v1" } },
  { supported: false, sessionId: null, provider: null },
])("does not prompt for missing login, configured providers, or unsupported engines: %j", async ({ supported, sessionId, provider }) => {
  state.status.mockResolvedValue({ supported, sessionId });
  state.root.call.mockResolvedValue({ provider });
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  await switchTo("在问");
  await finishSiteLoad();
  await switchTo("miniQ");
  await act(async () => {});
  expect(state.status).toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.keys).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});

it("refreshes miniQ after saving and does not prompt on subsequent switches", async () => {
  state.status.mockResolvedValue({ supported: true, sessionId: "session-a" });
  state.save.mockImplementationOnce(async () => {
    state.root.call.mockResolvedValue({ provider: { hasApiKey: true } });
  });
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  await switchTo("在问");
  await finishSiteLoad();
  await switchTo("miniQ");
  fireEvent.click(await screen.findByRole("radio", { name: /工作密钥/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(state.save).toHaveBeenCalledWith(state.root, "session-a", expect.any(AbortSignal), "test-key");
  expect(state.controller.connection.refreshProviderConfiguration).toHaveBeenCalledOnce();
  await switchTo("在问");
  await switchTo("miniQ");
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.keys).toHaveBeenCalledOnce();
});

it("does not import local credentials into an SSH workspace", async () => {
  state.host = "ssh-host";
  state.status.mockResolvedValue({ supported: true, sessionId: "session-a" });
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  await switchTo("在问");
  await finishSiteLoad();
  await switchTo("miniQ");
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.status).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});
