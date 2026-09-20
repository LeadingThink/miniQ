// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isTauriRuntime } from "../runtime";
import { SshConnections } from "./SshConnections";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../runtime", () => ({ isTauriRuntime: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("discovers SSH aliases and switches execution hosts without storing credentials", async () => {
  vi.mocked(invoke).mockResolvedValue([
    { alias: "work", hostName: "server.example", user: "dev", port: 2222 },
  ]);
  const select = vi.fn();
  const view = render(
    <SshConnections activeHost={null} onSelectHost={select} />,
  );
  expect(
    await screen.findByText("dev@server.example · 端口 2222"),
  ).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("ssh_hosts");
  fireEvent.click(screen.getByRole("button", { name: "连接 work" }));
  expect(select).toHaveBeenCalledWith("work");
  expect(localStorage.length).toBe(0);
  view.rerender(<SshConnections activeHost="work" onSelectHost={select} />);
  expect(screen.getByText("当前执行位置：work")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回此电脑" }));
  expect(select).toHaveBeenLastCalledWith(null);
});

it("adds from Enter inside the settings form without submitting provider settings", async () => {
  const submit = vi.fn((event) => event.preventDefault());
  const select = vi.fn();
  render(
    <form onSubmit={submit}>
      <SshConnections activeHost={null} onSelectHost={select} />
    </form>,
  );
  const input = screen.getByRole("textbox", { name: "添加主机" });
  fireEvent.change(input, { target: { value: "  dev@server.example  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(select).toHaveBeenCalledWith("dev@server.example"),
  );
  expect(submit).not.toHaveBeenCalled();
  expect(localStorage.getItem("miniq.ssh.saved-hosts")).toBe(
    '["dev@server.example"]',
  );
  expect(screen.queryByRole("textbox", { name: /密码|私钥|Key/ })).toBeNull();
});

it("rejects command/options/URLs and accepts a concrete IPv6 target", async () => {
  const select = vi.fn();
  render(<SshConnections activeHost={null} onSelectHost={select} />);
  const input = screen.getByRole("textbox", { name: "添加主机" });
  for (const target of [
    "ssh work",
    "-oProxyCommand=bad",
    "ssh://host",
    "host:2222",
    "user@@host",
    "host;touch x",
    "[host]",
  ]) {
    fireEvent.change(input, { target: { value: target } });
    fireEvent.click(screen.getByRole("button", { name: "添加并连接" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(select).not.toHaveBeenCalled();
  }
  fireEvent.change(input, { target: { value: "dev@[::1]" } });
  fireEvent.click(screen.getByRole("button", { name: "添加并连接" }));
  expect(select).toHaveBeenCalledWith("dev@[::1]");
});

it("preserves the active saved host until explicitly returning local, and removes only its saved entry", async () => {
  localStorage.setItem("miniq.ssh.saved-hosts", '["work","other"]');
  const select = vi.fn();
  const view = render(
    <SshConnections activeHost="work" onSelectHost={select} />,
  );
  await screen.findByText("当前执行位置：work");
  expect(
    (screen.getByRole("button", { name: "移除 work" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "移除 other" }));
  expect(localStorage.getItem("miniq.ssh.saved-hosts")).toBe('["work"]');
  expect(select).not.toHaveBeenCalled();
  view.rerender(<SshConnections activeHost={null} onSelectHost={select} />);
  fireEvent.click(screen.getByRole("button", { name: "移除 work" }));
  expect(localStorage.getItem("miniq.ssh.saved-hosts")).toBe("[]");
});

it("recovers discovery on refresh and surfaces connection errors independently", async () => {
  vi.mocked(invoke)
    .mockRejectedValueOnce(new Error("config unavailable"))
    .mockResolvedValueOnce([{ alias: "work" }]);
  render(
    <SshConnections
      activeHost={null}
      onSelectHost={vi.fn()}
      error="Permission denied"
    />,
  );
  expect(
    await screen.findByText(/读取 SSH 配置失败：config unavailable/),
  ).toBeTruthy();
  expect(screen.getByText("连接失败：Permission denied")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新 SSH 主机" }));
  await screen.findByRole("button", { name: "连接 work" });
  expect(screen.queryByText(/读取 SSH 配置失败/)).toBeNull();
  expect(screen.getByText("连接失败：Permission denied")).toBeTruthy();
});

it("keeps manual connection usable when persistent storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  const select = vi.fn();
  render(<SshConnections activeHost={null} onSelectHost={select} />);
  fireEvent.change(screen.getByRole("textbox", { name: "添加主机" }), {
    target: { value: "work" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加并连接" }));
  expect(await screen.findByText(/本机存储不可用/)).toBeTruthy();
  expect(select).toHaveBeenCalledWith("work");
});

it("disables repeated changes while connecting and does not expose native controls on web", async () => {
  localStorage.setItem("miniq.ssh.saved-hosts", '["work"]');
  const select = vi.fn();
  const view = render(
    <SshConnections activeHost={null} onSelectHost={select} pending />,
  );
  expect(await screen.findByText("正在连接，请稍候…")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "连接 work" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  view.unmount();
  vi.mocked(invoke).mockClear();
  vi.mocked(isTauriRuntime).mockReturnValue(false);
  render(<SshConnections activeHost={null} onSelectHost={select} />);
  expect(screen.getByText(/SSH 连接需要 miniQ 桌面客户端/)).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "添加主机" })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
