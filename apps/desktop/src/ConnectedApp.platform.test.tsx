// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import ConnectedApp from "./ConnectedApp";
import { listZaiwenConversations, listZaiwenMessages } from "./zaiwenHistory";

const state = vi.hoisted(() => ({
  panel: vi.fn(), mount: vi.fn(), unmount: vi.fn(), restore: vi.fn(),
  controller: {
    client: { mode: "local" }, catalog: {}, setError: vi.fn(),
    navigation: {}, actions: {}, updater: {},
  },
}));
const session = { token: "test-token", user: { uid: "test-user", nick: "user" } };
vi.mock("./runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./desktopHost", () => ({ useDesktopHost: () => ({ host: null, sidebarCollapsed: false }) }));
vi.mock("./hooks/useMiniqApp", () => ({ useMiniqApp: () => state.controller }));
vi.mock("./components/UnifiedSidebar", () => ({ UnifiedSidebar: ({ conversationItems }: { conversationItems?: (query: string, filter: "all") => ReactNode }) => <aside className="sidebar" aria-label="本地会话">{conversationItems?.("", "all")}</aside> }));
vi.mock("./components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("./components/AppShell", () => ({ AppShell: () => {
  useEffect(() => { state.mount(); return state.unmount; }, []);
  return <section aria-label="miniQ 工作台" />;
} }));
vi.mock("./components/ZaiwenLoginDialog", () => ({ ZaiwenLoginDialog: () => null }));
vi.mock("./zaiwenHistory", async (original) => ({
  ...await original<typeof import("./zaiwenHistory")>(),
  listZaiwenConversations: vi.fn().mockResolvedValue({ items: [{ id: "cloud", title: "云端会话", created: 1700000000 }], total: 1, cursor: null }),
  listZaiwenMessages: vi.fn().mockResolvedValue({ items: [{ id: "m", content: "云端消息", role: "assistant", created: 1700000000 }], total: 1, cursor: null }),
}));
vi.mock("./zaiwenAuth", async (original) => ({
  ...await original<typeof import("./zaiwenAuth")>(),
  getZaiwenSession: () => ({ token: "test-token", user: { uid: "test-user", nick: "user" } }),
  restoreZaiwenSession: state.restore,
}));
vi.mock("./zaiwenChat", () => ({ listZaiwenChatModels: vi.fn().mockResolvedValue([{ key: "model" }]) }));
vi.mock("./hooks/useBrowserPanel", () => ({ useBrowserPanel: state.panel }));

beforeEach(() => {
  vi.clearAllMocks();
  state.restore.mockResolvedValue(session);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["Win32", "MacIntel", "Linux x86_64"])("retains the local sidebar and adds native cloud conversations without a site WebView on %s", async (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const { container } = render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  expect(listZaiwenConversations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /miniQ/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /在问/ }));
  fireEvent.click(await screen.findByRole("button", { name: "云端会话" }));
  // The real conversation UI is lazy-loaded, including its Markdown dependencies.
  await screen.findByText("云端消息", undefined, { timeout: 5000 });
  const main = screen.getByRole("main", { name: "在问会话" });
  expect(container.querySelectorAll(".sidebar")).toHaveLength(1);
  expect(screen.getByLabelText("本地会话")).toBeTruthy();
  expect(state.mount).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "在问" }));
  expect(screen.getByRole("menu", { name: "选择平台" })).toBeTruthy();
  expect(screen.getByRole("main", { name: "在问会话" })).toBe(main);
  fireEvent.click(screen.getByRole("menuitemradio", { name: /在问/ }));
  expect(screen.queryByRole("menu", { name: "选择平台" })).toBeNull();
  expect(state.restore).toHaveBeenCalledOnce();
  expect(listZaiwenConversations).toHaveBeenCalledOnce();
  expect(listZaiwenMessages).toHaveBeenCalledOnce();
  expect(state.panel).not.toHaveBeenCalled();
  expect(container.querySelector("iframe")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "在问" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /miniQ/ }));
  expect(screen.getByLabelText("本地会话")).toBeTruthy();
  expect(screen.queryByRole("main", { name: "在问会话" })).toBeNull();
  expect(state.unmount).not.toHaveBeenCalled();
});
