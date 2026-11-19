// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import type { RpcClient } from "../rpc";

const mocks = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), keys: vi.fn(), suspended: vi.fn() }));
vi.mock("../zaiwenKeyImport", async (original) => ({ ...(await original<typeof import("../zaiwenKeyImport")>()),
  zaiwenSessionStatus: mocks.status, selectZaiwenKey: mocks.save, loadZaiwenImportKeys: mocks.keys,
}));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../browserEvents", () => ({ listenBrowserEvent: () => () => {} }));
vi.mock("../hooks/useBrowserPanel", async () => {
  const { useOpenDialog } = await import("../hooks/useOpenDialog");
  return { useBrowserPanel: (_url: string, _surface: unknown, hidden: boolean) => {
    const dialogOpen = useOpenDialog();
    mocks.suspended(hidden || dialogOpen);
    return { viewId: "zaiwen-site", loading: false, loadError: null, error: null, setError: vi.fn() };
  } };
});
import { ZaiwenSite } from "./ZaiwenSite";
const provider = { baseUrl: "https://other.test/v1", model: "other", hasApiKey: true };
const key = { key_id: "first", sk: "sk-first-private-fixture", remark: "临时密钥", is_active: true, expire_time: 4102444800 };
const second = { ...key, key_id: "second", sk: "sk-second-private-fixture", remark: "API Key 2026-04-13" };
const client = { mode: "local", call: vi.fn() } as unknown as RpcClient;

function SiteWithToolbar(props: Omit<ComponentProps<typeof ZaiwenSite>, "toolbar">) {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  return <><header aria-label="应用顶栏"><div ref={setToolbar} /></header><ZaiwenSite {...props} toolbar={toolbar} /></>;
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.status.mockResolvedValue({ supported: true, sessionId: "opaque-session" });
  vi.mocked(client.call).mockResolvedValue({ provider });
  mocks.keys.mockResolvedValue([key]); mocks.save.mockResolvedValue(key);
});
afterEach(cleanup);

it("directly lists all choices with masked keys and saves exactly the chosen key", async () => {
  mocks.keys.mockResolvedValue([key, second]);
  mocks.save.mockResolvedValue(second);
  render(<SiteWithToolbar active client={client} />);
  const dialog = await screen.findByRole("dialog", { name: "选择 API Key" });
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  expect(dialog.textContent).not.toContain(key.sk); expect(dialog.textContent).not.toContain(second.sk);
  expect(dialog.textContent).toContain("sk-fir••••ture");
  expect(dialog.textContent).not.toContain("将读取"); expect(dialog.textContent).not.toContain(provider.baseUrl);
  expect(dialog.textContent).not.toContain("余额");
  const save = screen.getByRole("button", { name: "保存" });
  expect(save.hasAttribute("disabled")).toBe(true); expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: /API Key 2026-04-13/ }));
  expect(save.hasAttribute("disabled")).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(client, "opaque-session", expect.any(AbortSignal), "second"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("已选择在问 API Key")).toBeTruthy();
  expect(screen.getByRole("button", { name: "选择在问 API Key" })).toHaveProperty("disabled", false);
  await waitFor(() => expect(mocks.suspended).toHaveBeenLastCalledWith(false));
});

it("keeps saved credentials, and clicking import immediately opens the list", async () => {
  vi.mocked(client.call).mockResolvedValue({ provider: { ...provider, baseUrl: "https://oneapi.zaiwenai.com/v1" } });
  render(<SiteWithToolbar active client={client} />);
  const keyStatus = await screen.findByText("已使用miniQ配置的API Key");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.suspended).toHaveBeenLastCalledWith(false); expect(mocks.keys).not.toHaveBeenCalled();
  const importButton = screen.getByRole("button", { name: "选择在问 API Key" });
  expect(importButton.nextElementSibling).toBe(keyStatus);
  expect(importButton.closest("header")).toBe(screen.getByRole("banner", { name: "应用顶栏" }));
  expect(importButton.classList.contains("ui-button--primary")).toBe(true);
  expect(screen.getByRole("main", { name: "在问主站" }).querySelector(".zaiwen-key-import")).toBeNull();
  fireEvent.click(importButton);
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(mocks.keys).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
  expect(screen.queryByText(/将在问 API Key 导入 miniQ/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByText("已使用miniQ配置的API Key")).toBeTruthy();
});

it("shows the saved miniQ key status in the title bar before main-site login", async () => {
  mocks.status.mockResolvedValue({ supported: true, sessionId: null });
  vi.mocked(client.call).mockResolvedValue({ provider: { ...provider, baseUrl: "https://oneapi.zaiwenai.com/v1" } });
  const { rerender } = render(<SiteWithToolbar active client={client} />);
  const keyStatus = await screen.findByText("已使用miniQ配置的API Key");
  expect(keyStatus.closest("header")).toBe(screen.getByRole("banner", { name: "应用顶栏" }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(mocks.keys).not.toHaveBeenCalled();
  rerender(<SiteWithToolbar active={false} client={client} />);
  expect(screen.queryByText("已使用miniQ配置的API Key")).toBeNull();
});

it("automatically requires a key choice each time the user enters without a configured key", async () => {
  vi.mocked(client.call).mockResolvedValue({ provider: null });
  mocks.keys.mockResolvedValue([key, second]);
  const { rerender } = render(<SiteWithToolbar active={false} client={client} />);
  expect(mocks.keys).not.toHaveBeenCalled();
  rerender(<SiteWithToolbar active client={client} />);
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(screen.getAllByRole<HTMLInputElement>("radio").every((radio) => !radio.checked)).toBe(true);
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("已使用miniQ配置的API Key")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  rerender(<SiteWithToolbar active={false} client={client} />);
  rerender(<SiteWithToolbar active client={client} />);
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(mocks.keys).toHaveBeenCalledTimes(2); expect(mocks.save).not.toHaveBeenCalled();
});

it("disables only the current key and allows switching to another key without changing miniQ settings", async () => {
  mocks.keys.mockResolvedValue([key, second]);
  mocks.save.mockImplementation(async (_client, _sessionId, _signal, id) => id === "second" ? second : key);
  render(<SiteWithToolbar active client={client} />);
  const radio = await screen.findByRole("radio", { name: /临时密钥/ });
  await waitFor(() => expect(mocks.suspended).toHaveBeenLastCalledWith(true));
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(radio); fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.getByText("已选择在问 API Key")).toBeTruthy());
  await waitFor(() => expect(mocks.suspended).toHaveBeenLastCalledWith(false));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "选择在问 API Key" }));
  const current = await screen.findByRole("radio", { name: /临时密钥/ });
  expect(current).toHaveProperty("disabled", true);
  expect(current).toHaveProperty("checked", true);
  expect(current.closest("label")?.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("当前已选")).toBeTruthy();
  const other = screen.getByRole("radio", { name: /API Key 2026-04-13/ });
  expect(other).toHaveProperty("disabled", false);
  const save = screen.getByRole("button", { name: "保存" });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.click(current); fireEvent.click(save);
  expect(mocks.save).toHaveBeenCalledOnce();
  fireEvent.click(other);
  expect(save).toHaveProperty("disabled", false);
  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.save).toHaveBeenLastCalledWith(client, "opaque-session", expect.any(AbortSignal), "second");
  fireEvent.click(screen.getByRole("button", { name: "选择在问 API Key" }));
  const next = await screen.findByRole("radio", { name: /API Key 2026-04-13/ });
  expect(next).toHaveProperty("disabled", true);
  expect(next).toHaveProperty("checked", true);
  expect(screen.getByRole("radio", { name: /临时密钥/ })).toHaveProperty("disabled", false);
  expect(vi.mocked(client.call).mock.calls.every(([method]) => method === "settings.get")).toBe(true);
});

it("keeps a single current key disabled after switching away and back", async () => {
  const { rerender } = render(<SiteWithToolbar active client={client} />);
  fireEvent.click(await screen.findByRole("radio", { name: /临时密钥/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  rerender(<SiteWithToolbar active={false} client={client} />);
  rerender(<SiteWithToolbar active client={client} />);
  const reopen = screen.getByRole("button", { name: "选择在问 API Key" });
  await waitFor(() => expect(reopen).toHaveProperty("disabled", false));
  fireEvent.click(reopen);
  const current = await screen.findByRole("radio", { name: /临时密钥/ });
  expect(current).toHaveProperty("disabled", true);
  expect(current).toHaveProperty("checked", true);
  expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
  expect(mocks.save).toHaveBeenCalledOnce();
});

it("shows disabled and expired keys but prevents selecting them", async () => {
  mocks.keys.mockResolvedValue([key, { ...second, is_active: false }, { ...second, key_id: "expired", remark: "过期密钥", expire_time: 1 }]);
  render(<SiteWithToolbar active client={client} />);
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.getByRole("radio", { name: /API Key 2026-04-13/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("radio", { name: /过期密钥/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("已停用")).toBeTruthy(); expect(screen.getByText("已过期")).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("offers explicit creation only for an empty account", async () => {
  mocks.keys.mockResolvedValue([]);
  render(<SiteWithToolbar active client={client} />);
  await screen.findByText("暂无 API Key");
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "创建并使用" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(client, "opaque-session", expect.any(AbortSignal), null));
});

it("leaves settings untouched when the user cancels", async () => {
  render(<SiteWithToolbar active client={client} />);
  await screen.findByRole("radio", { name: /临时密钥/ });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(mocks.suspended).toHaveBeenLastCalledWith(false));
  expect(mocks.save).not.toHaveBeenCalled();
});

it("shows loading and allows retry without another confirmation screen", async () => {
  let fail!: (reason: Error) => void;
  mocks.keys.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<SiteWithToolbar active client={client} />);
  await screen.findByText("正在加载 API Key…");
  expect(screen.getByRole("button", { name: "加载中…" }).hasAttribute("disabled")).toBe(true);
  fail(new Error("加载失败"));
  const retry = await screen.findByRole("button", { name: "重试" });
  fireEvent.click(retry);
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(mocks.keys).toHaveBeenCalledTimes(2); expect(mocks.save).not.toHaveBeenCalled();
});

it("does not offer automatic import on an unsupported engine", async () => {
  mocks.status.mockResolvedValue({ supported: false, sessionId: null });
  render(<SiteWithToolbar active client={client} />);
  await screen.findByText(/此平台尚不支持读取主站登录态/);
  expect(screen.queryByRole("dialog")).toBeNull(); expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
