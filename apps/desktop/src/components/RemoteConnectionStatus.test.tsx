// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { RemoteConnectionStatus } from "./RemoteConnectionStatus";

const host = vi.hoisted(() => ({ pending: false, host: "build", error: null as string | null, selectHost: vi.fn(),
  registry: { hosts: [{ hostId: "build", label: "构建服务器", state: "connected" }, { hostId: "other", label: "另一台电脑", state: "disconnected" }] },
  catalogs: { '"build"': { label: "构建服务器" } },
}));
vi.mock("../desktopHost", () => ({ useDesktopHost: () => host }));
beforeEach(() => {
  host.host = "build"; host.pending = false; host.error = null; host.selectHost.mockReset();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function app() {
  return {
    client: { mode: "remote", sshHost: "build" },
    connection: { connected: true, phase: "connected", retrying: false, retryConnection: vi.fn(), health: { daemonVersion: "0.1.46" } },
    catalog: { currentSession: { title: "这是很长的完整任务标题，点击后也必须保留全部内容", status: "running" }, currentWorkspace: { name: "工程项目", path: "/home/user/项目路径" } },
    feed: { messages: [] }, review: { data: { files: [] } },
    navigation: { setShowSettings: vi.fn() },
  } as unknown as MiniqAppController;
}

it("opens the full title, project and exact machine without issuing requests", () => {
  const controller = app();
  render(<RemoteConnectionStatus app={controller} />);
  fireEvent.click(screen.getByRole("button", { name: "查看完整会话标题与连接信息" }));
  expect(screen.getByRole("dialog", { name: "会话与连接信息" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: controller.catalog.currentSession!.title })).toBeTruthy();
  expect(screen.getByText("/home/user/项目路径")).toBeTruthy();
  expect(screen.getByText("桌面版本 0.1.46")).toBeTruthy();
  expect(controller.connection.retryConnection).not.toHaveBeenCalled();
  expect(host.selectHost).not.toHaveBeenCalled();
});

it("offers explicit resync and connection settings and restores trigger focus on close", () => {
  const controller = app();
  render(<RemoteConnectionStatus app={controller} />);
  const trigger = screen.getByRole("button", { name: "已连接电脑，查看连接详情" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "重新同步" }));
  expect(controller.connection.retryConnection).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "连接设置" }));
  expect(controller.navigation.setShowSettings).toHaveBeenCalledWith(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("shows offline guidance and prevents competing retries while recovery runs", () => {
  const controller = app();
  controller.connection.connected = false;
  controller.connection.retrying = true;
  const view = render(<RemoteConnectionStatus app={controller} />);
  fireEvent.click(screen.getByRole("button", { name: /查看连接详情/ }));
  expect((screen.getByRole("button", { name: "正在恢复或同步…" }) as HTMLButtonElement).disabled).toBe(true);
  controller.connection.retrying = false;
  view.rerender(<RemoteConnectionStatus app={controller} />);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  expect(screen.getByRole("status").textContent).toBe("当前设备网络已断开");
  expect((screen.getByRole("button", { name: "重试连接" }) as HTMLButtonElement).disabled).toBe(true);
  expect(controller.connection.retryConnection).not.toHaveBeenCalled();
});

it("switches only the selected saved host and explains a failed switch without raw errors", () => {
  const controller = app();
  const view = render(<RemoteConnectionStatus app={controller} />);
  fireEvent.click(screen.getByRole("button", { name: /查看连接详情/ }));
  fireEvent.click(screen.getByRole("button", { name: /另一台电脑/ }));
  expect(host.selectHost).toHaveBeenCalledExactlyOnceWith("other");
  host.error = "permission denied with private connection data";
  view.rerender(<RemoteConnectionStatus app={controller} />);
  expect(screen.getByRole("dialog", { name: "会话与连接信息" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("未能切换电脑，请确认该电脑在线后重试。");
});

it("closes the retained host view's native dialog only after the active host changes", () => {
  const controller = app();
  const view = render(<RemoteConnectionStatus app={controller} />);
  fireEvent.click(screen.getByRole("button", { name: /查看连接详情/ }));
  const dialog = screen.getByRole("dialog", { name: "会话与连接信息" }) as HTMLDialogElement;
  fireEvent.click(screen.getByRole("button", { name: /另一台电脑/ }));
  host.pending = true;
  view.rerender(<RemoteConnectionStatus app={controller} />);
  expect(dialog.open).toBe(true);
  host.host = "other";
  host.pending = false;
  view.rerender(<RemoteConnectionStatus app={controller} />);
  expect(dialog.open).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  host.host = "build";
  view.rerender(<RemoteConnectionStatus app={controller} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
