// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalSettings } from "./TerminalSettings";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const missing = {
  path: "/Users/test/.local/bin/miniq",
  installed: false,
  version: null,
  versionError: null,
  desktopVersion: "0.1.53",
  installCommand: "curl -fsSL https://oss.zaiwen.top/releases/miniq/install.sh | sh",
};
const installed = { ...missing, installed: true, version: "miniq 0.1.53" };

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(missing);
});
afterEach(cleanup);

it("checks the installed CLI without installing until explicitly requested", async () => {
  render(<TerminalSettings />);
  expect(await screen.findByText("尚未安装终端命令")).toBeTruthy();
  expect(invoke.mock.calls).toEqual([["terminal_install_status"]]);
  expect(screen.getByText(missing.path)).toBeTruthy();
  expect(screen.getByText(missing.installCommand)).toBeTruthy();
});

it("runs one installer, blocks repeated clicks, and shows the resulting version", async () => {
  let complete: (value: { status: typeof installed; log: string }) => void = () => {};
  invoke.mockImplementation((command) => command === "terminal_install_status"
    ? Promise.resolve(missing)
    : new Promise((resolve) => { complete = resolve; }));
  render(<TerminalSettings />);
  await screen.findByText("尚未安装终端命令");
  fireEvent.click(screen.getByRole("button", { name: "安装终端命令" }));
  const pending = screen.getByRole("button", { name: "正在下载并安装…" });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(pending);
  expect(invoke.mock.calls.filter(([command]) => command === "install_terminal_command")).toHaveLength(1);
  complete({ status: installed, log: "Installed successfully" });
  expect(await screen.findByText("miniq 0.1.53")).toBeTruthy();
  expect(screen.getByText(/重新打开终端/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "更新终端命令" })).toBeTruthy();
  expect(screen.getByText("Installed successfully")).toBeTruthy();
});

it("keeps failure details visible and allows an explicit retry", async () => {
  invoke.mockImplementation((command) => command === "terminal_install_status"
    ? Promise.resolve(installed)
    : Promise.reject(new Error("下载校验失败，原安装保持可用")));
  render(<TerminalSettings />);
  await screen.findByText("miniq 0.1.53");
  fireEvent.click(screen.getByRole("button", { name: "更新终端命令" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "下载校验失败，原安装保持可用");
  expect((screen.getByRole("button", { name: "更新终端命令" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/已安装。重新打开终端/)).toBeNull();
});

it("recovers a failed status check through refresh", async () => {
  invoke.mockRejectedValueOnce(new Error("无法确定安装目录"));
  render(<TerminalSettings />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "无法确定安装目录");
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  expect(await screen.findByText("尚未安装终端命令")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("reports a broken binary distinctly from an absent installation", async () => {
  invoke.mockResolvedValue({ ...installed, version: null, versionError: "终端版本检查失败" });
  render(<TerminalSettings />);
  expect(await screen.findByText("已安装，版本读取失败")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("终端版本检查失败");
  expect(screen.getByRole("button", { name: "更新终端命令" })).toBeTruthy();
});
