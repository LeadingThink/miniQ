// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileEntry } from "./MobileEntry";

const state = vi.hoisted(() => ({ native: false, store: vi.fn(), load: vi.fn() }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => state.native }));
vi.mock("../remoteAccess", async (original) => ({ ...await original<typeof import("../remoteAccess")>(), storeRemoteCredentials: state.store, loadRemoteCredentials: state.load }));
vi.mock("./MobileUpdateCheck", () => ({ MobileUpdateCheck: () => null }));
vi.mock("@capacitor/app", () => ({ App: { addListener: async () => ({ remove: vi.fn() }) } }));
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); state.native = false;
  state.store.mockReset().mockResolvedValue({}); state.load.mockReset().mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function enterRemote() {
  fireEvent.click(screen.getByRole("button", { name: /远程桌面/ }));
  fireEvent.change(screen.getByLabelText("在问 API Key"), { target: { value: " sk-private-test " } });
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意" }));
}

it("saves and enters remote once when the user submits repeatedly", async () => {
  let finish!: () => void;
  state.store.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const onRemote = vi.fn();
  render(<MobileEntry onRemote={onRemote} />);
  enterRemote();
  const button = screen.getByRole("button", { name: "连接桌面端" });
  fireEvent.submit(button.closest("form")!);
  fireEvent.submit(button.closest("form")!);
  expect(state.store).toHaveBeenCalledTimes(1);
  expect(state.store.mock.calls[0][0].apiKey).toBe("sk-private-test");
  expect((screen.getByRole("button", { name: "正在准备连接…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("正在安全保存");
  await act(async () => finish());
  expect(onRemote).toHaveBeenCalledTimes(1);
});

it("keeps the entry recoverable after a secure storage error and hides raw credentials", async () => {
  state.store.mockRejectedValueOnce(new Error("failed saving sk-private-test"));
  const onRemote = vi.fn();
  render(<MobileEntry onRemote={onRemote} />);
  enterRemote();
  fireEvent.click(screen.getByRole("button", { name: "连接桌面端" }));
  expect((await screen.findByRole("alert")).textContent).not.toContain("sk-private-test");
  expect(onRemote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "连接桌面端" }));
  await waitFor(() => expect(onRemote).toHaveBeenCalledTimes(1));
});

it("shows a key only after the user explicitly asks and guides missing-key input", () => {
  render(<MobileEntry onRemote={vi.fn()} />);
  const input = screen.getByLabelText("在问 API Key") as HTMLInputElement;
  expect(input.type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
  expect(input.type).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "隐藏 API Key" }));
  expect(input.type).toBe("password");
  expect(screen.getByRole("link", { name: /前往在问获取/ }).getAttribute("href")).toBe("https://platform.zaiwenai.com/");
  fireEvent.click(screen.getByRole("button", { name: /远程桌面/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意" }));
  fireEvent.click(screen.getByRole("button", { name: "连接桌面端" }));
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole("alert").textContent).toBe("请输入在问 API Key");
});

it("explains native credential loading and allows manual recovery if it fails", async () => {
  state.native = true;
  let fail!: (cause: Error) => void;
  state.load.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<MobileEntry onRemote={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toContain("正在读取");
  expect((screen.getByLabelText("在问 API Key") as HTMLInputElement).disabled).toBe(true);
  await act(async () => fail(new Error("private storage details")));
  expect(screen.getByRole("alert").textContent).toBe("暂时无法读取已保存的 Key，你可以重新输入后继续。");
  expect((screen.getByLabelText("在问 API Key") as HTMLInputElement).disabled).toBe(false);
});
