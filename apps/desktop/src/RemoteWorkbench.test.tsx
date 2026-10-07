// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoteWorkbench } from "./RemoteWorkbench";
import type { useDesktopHost } from "./desktopHost";
import { hostKey } from "./hostWorkspace";
import { rememberSelectedDesktop } from "./remoteDevices";
const state = vi.hoisted(() => ({ desktop: null as ReturnType<typeof useDesktopHost>, directory: { scope: "room", devices: [] as { id: string; name: string; online: boolean }[], loading: false, error: "", refresh: vi.fn() }, roots: [] as { targetDeviceId: string; disconnect: ReturnType<typeof vi.fn> }[] }));
vi.mock("./hooks/useRemoteDevices", () => ({ useRemoteDevices: () => state.directory }));
vi.mock("./rpc", () => ({ RpcClient: class { targetDeviceId: string; disconnect = vi.fn(); constructor(info: {targetDeviceId: string}) { this.targetDeviceId = info.targetDeviceId; state.roots.push(this); } } }));
vi.mock("./desktopHost", () => ({ DesktopHostProvider: ({children}: {children: React.ReactNode}) => children, useDesktopHost: () => state.desktop }));
vi.mock("./ConnectedApp", () => ({ default: () => <div>工作台</div> }));
vi.mock("./taskBanner", () => ({ dismissTaskBanner: vi.fn() }));
const credentials = { apiKey: "test", relayUrl: "wss://relay.test", deviceId: "phone", deviceName: "phone" };
const a = { id: "a", name: "电脑A", online: false }, b = { id: "b", name: "电脑B", online: true };
beforeEach(() => { localStorage.clear(); state.desktop = null; state.roots.length = 0; state.directory.devices = [b]; });
afterEach(cleanup);
it("首次即使仅一台在线也等待选择，不创建业务连接", () => {
  render(<RemoteWorkbench credentials={credentials} theme="night" onThemeChange={() => {}} />);
  expect(screen.getByRole("region", { name: "选择连接的电脑" })).toBeTruthy();
  expect(state.roots).toHaveLength(0);
});
it("恢复离线A不切到在线B；显式切换销毁A，新建B，目录更新不换根", async () => {
  rememberSelectedDesktop("room", a);
  const view = render(<RemoteWorkbench credentials={credentials} theme="night" onThemeChange={() => {}} />);
  await waitFor(() => expect(state.roots).toHaveLength(1));
  expect(state.roots[0].targetDeviceId).toBe("a");
  expect(screen.getByText(/电脑A 当前离线/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /电脑A.*切换电脑/ }));
  fireEvent.click(screen.getByRole("button", { name: /电脑B/ }));
  await waitFor(() => expect(state.roots).toHaveLength(2));
  expect(state.roots[0].disconnect).toHaveBeenCalled();
  expect(state.roots[1].targetDeviceId).toBe("b");
  state.directory.devices = [a];
  view.rerender(<RemoteWorkbench credentials={credentials} theme="night" onThemeChange={() => {}} />);
  expect(state.roots).toHaveLength(2);
  expect(screen.getByText(/电脑B 当前离线/)).toBeTruthy();
});

it("clears a missing-target notification and aborts an older asynchronous destination", async () => {
  rememberSelectedDesktop("room", b);
  const openSession = vi.fn();
  state.desktop = { root: { targetDeviceId: "b" }, catalogs: { [hostKey(null)]: { catalogStatus: "ready" } }, openSession } as unknown as ReturnType<typeof useDesktopHost>;
  const view = render(<RemoteWorkbench credentials={credentials} theme="night" onThemeChange={() => {}} />);
  const notify = (detail: object) => act(() => { window.dispatchEvent(new CustomEvent("miniq:remote-notification-target", { detail })); });
  notify({ targetDeviceId: "b", host: "slow-ssh", sessionId: "old-session" });
  expect(openSession).toHaveBeenCalledTimes(1);
  const signal = openSession.mock.calls[0][1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  notify({ host: null, sessionId: "identity-missing" });
  expect(signal.aborted).toBe(true);
  // A second destination waiting for catalogs must be cleared, not replayed when ready.
  state.desktop!.catalogs[hostKey(null)].catalogStatus = "loading";
  notify({ targetDeviceId: "b", host: null, sessionId: "waiting-session" });
  notify({ host: null, sessionId: "identity-missing" });
  state.desktop!.catalogs[hostKey(null)].catalogStatus = "ready";
  view.rerender(<RemoteWorkbench credentials={credentials} theme="night" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "返回当前电脑" }));
  expect(openSession).toHaveBeenCalledTimes(1);
});
