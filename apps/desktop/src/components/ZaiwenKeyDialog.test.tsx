// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { useZaiwenKeyImport } from "../hooks/useZaiwenKeyImport";
import { ZaiwenKeyDialog } from "./ZaiwenKeyDialog";

const mocks = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), keys: vi.fn() }));
vi.mock("../zaiwenKeyImport", async (original) => ({ ...(await original<typeof import("../zaiwenKeyImport")>()),
  zaiwenSessionStatus: mocks.status, importZaiwenKey: mocks.save, loadZaiwenImportKeys: mocks.keys,
}));
const provider = { baseUrl: "https://other.test/v1", model: "other", hasApiKey: false };
const key = { key_id: "first", sk: "sk-first-private-fixture", remark: "临时密钥", is_active: true, expire_time: 4102444800 };
const second = { ...key, key_id: "second", sk: "sk-second-private-fixture", remark: "API Key 2026-04-13" };
const client = { mode: "local", call: vi.fn() } as unknown as RpcClient;

function Chooser({ active }: { active: boolean }) {
  const keyImport = useZaiwenKeyImport(active, active, client);
  return <ZaiwenKeyDialog open={active} keyImport={keyImport} />;
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.status.mockResolvedValue({ supported: true, sessionId: "opaque-session" });
  vi.mocked(client.call).mockResolvedValue({ provider });
  mocks.keys.mockResolvedValue([key]); mocks.save.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("directly lists all choices with masked keys and saves exactly the chosen key", async () => {
  mocks.keys.mockResolvedValue([key, second]);
  render(<Chooser active />);
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
  expect(screen.queryByRole("button", { name: "选择在问 API Key" })).toBeNull();
});

it("automatically requires a key choice each time the user enters without a configured key", async () => {
  vi.mocked(client.call).mockResolvedValue({ provider: null });
  mocks.keys.mockResolvedValue([key, second]);
  const { rerender } = render(<Chooser active={false} />);
  expect(mocks.keys).not.toHaveBeenCalled();
  rerender(<Chooser active />);
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(screen.getAllByRole<HTMLInputElement>("radio").every((radio) => !radio.checked)).toBe(true);
  expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("已使用miniQ配置的API Key")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  rerender(<Chooser active={false} />);
  rerender(<Chooser active />);
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(mocks.keys).toHaveBeenCalledTimes(2); expect(mocks.save).not.toHaveBeenCalled();
});

it("shows disabled and expired keys but prevents selecting them", async () => {
  mocks.keys.mockResolvedValue([key, { ...second, is_active: false }, { ...second, key_id: "expired", remark: "过期密钥", expire_time: 1 }]);
  render(<Chooser active />);
  await screen.findByRole("radio", { name: /临时密钥/ });
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.getByRole("radio", { name: /API Key 2026-04-13/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("radio", { name: /过期密钥/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("已停用")).toBeTruthy(); expect(screen.getByText("已过期")).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("offers explicit creation only for an empty account", async () => {
  mocks.keys.mockResolvedValue([]);
  render(<Chooser active />);
  await screen.findByText("暂无 API Key");
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "创建并使用" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(client, "opaque-session", expect.any(AbortSignal), null));
});

it("leaves settings untouched when the user cancels", async () => {
  render(<Chooser active />);
  await screen.findByRole("radio", { name: /临时密钥/ });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(mocks.save).not.toHaveBeenCalled();
});

it("shows loading and allows retry without another confirmation screen", async () => {
  let fail!: (reason: Error) => void;
  mocks.keys.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<Chooser active />);
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
  render(<Chooser active />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).toBeNull(); expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
