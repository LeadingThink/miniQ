// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import ConnectedApp from "./ConnectedApp";

const state = vi.hoisted(() => ({
  restore: vi.fn(),
  mounts: vi.fn(),
  unmounts: vi.fn(),
  controller: {
    client: { mode: "local" }, catalog: {}, setError: vi.fn(),
    navigation: {}, actions: {}, updater: {},
  },
}));
const session = { token: "test-token", user: { uid: "test-user", nick: "user" } };

vi.mock("./desktopHost", () => ({ useDesktopHost: () => ({ host: null, sidebarCollapsed: false }) }));
vi.mock("./hooks/useMiniqApp", () => ({ useMiniqApp: () => state.controller }));
vi.mock("./components/AppMenuBar", () => ({ AppMenuBar: ({ platform, onPlatformChange }: { platform: string; onPlatformChange: (value: "miniq" | "zaiwen") => void }) =>
  <button type="button" data-platform={platform} onClick={() => onPlatformChange(platform === "miniq" ? "zaiwen" : "miniq")}>切换平台</button> }));
vi.mock("./components/AppShell", () => ({ AppShell: ({ active }: { active: boolean }) => {
  useEffect(() => { state.mounts(); return state.unmounts; }, []);
  return <section aria-label="miniQ 工作台" data-active={String(active)} />;
} }));
vi.mock("./components/ZaiwenSiteView", () => ({ ZaiwenSiteView: ({ session: value, active }: { session: typeof session; active?: boolean }) =>
  <main aria-label="在问主站" hidden={!active} data-token={value.token}>在问网页</main> }));
vi.mock("./components/ZaiwenLoginDialog", () => ({ ZaiwenLoginDialog: ({ open, onLogin, onClose }: {
  open: boolean; onLogin: (value: typeof session) => void; onClose: () => void;
}) => open ? <div role="dialog" aria-label="登录在问"><button onClick={() => onLogin(session)}>完成登录</button><button onClick={onClose}>取消登录</button></div> : null }));
vi.mock("./zaiwenAuth", async (original) => ({
  ...await original<typeof import("./zaiwenAuth")>(),
  getZaiwenSession: () => session,
  restoreZaiwenSession: state.restore,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.restore.mockResolvedValue(session);
});
afterEach(() => cleanup());

it("switches to the real 在问 page and keeps the miniQ workspace mounted", async () => {
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  expect(screen.getByLabelText("miniQ 工作台").getAttribute("data-active")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  await screen.findByRole("main", { name: "在问主站" });
  expect(state.restore).toHaveBeenCalledOnce();
  expect(screen.getByRole("main", { name: "在问主站" }).getAttribute("data-token")).toBe(session.token);
  expect(screen.getByLabelText("miniQ 工作台").getAttribute("data-active")).toBe("false");
  expect(state.mounts).toHaveBeenCalledOnce();
  expect(state.unmounts).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  expect(screen.queryByRole("main", { name: "在问主站" })).toBeNull();
  expect(screen.getByLabelText("miniQ 工作台").getAttribute("data-active")).toBe("true");
});

it("requires 在问 login before replacing the local page", async () => {
  vi.mocked(state.restore).mockResolvedValue(null);
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  expect(await screen.findByRole("dialog", { name: "登录在问" })).toBeTruthy();
  expect(screen.queryByRole("main", { name: "在问主站" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
  expect(screen.getByLabelText("miniQ 工作台").getAttribute("data-active")).toBe("true");
});
