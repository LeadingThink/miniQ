// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { useSessionFileAccess } from "./sessionFileAccess";
import type { ReactNode } from "react";

// Entry routing has no transport dependency; host lifecycle is covered by the
// real-provider isolation tests in desktopHost.test.tsx.
vi.mock("./desktopHost", () => ({ DesktopHostProvider: ({ children }: { children: ReactNode }) => children, useDesktopHost: () => null }));

const state = vi.hoisted(() => {
  let release!: () => void;
  return {
    remote: true,
    consent: true,
    share: null as string | null,
    loadCredentials: vi.fn(),
    directoryMount: vi.fn(),
    directoryUnmount: vi.fn(),
    loadHarness: vi.fn(),
    useHarness: vi.fn(),
    themeChange: vi.fn(),
    harnessReady: new Promise<void>((resolve) => { release = resolve; }),
    releaseHarness: () => release(),
  };
});
vi.mock("./remoteAccess", () => ({
  isRemoteBrowserEntry: () => state.remote,
  loadRemoteCredentials: state.loadCredentials,
}));
vi.mock("./hooks/useRemoteDevices", async () => {
  const { useState, useEffect } = await import("react");
  return { useRemoteDevices: () => {
    useState(() => { state.directoryMount(); return null; });
    useEffect(() => () => { state.directoryUnmount(); }, []);
    return { scope: "test-room", devices: [{ id: "desktop-test", name: "测试电脑", online: true }], loading: false, error: "", refresh: vi.fn() };
  } };
});
vi.mock("./mobilePrivacy", () => ({ hasMobilePrivacyConsent: () => state.consent }));
vi.mock("./sharing", () => ({ sharedSessionId: () => state.share }));
vi.mock("./theme", () => {
  const appearance = { theme: "jade" };
  return { getAppearance: () => appearance, subscribeAppearance: () => () => {}, storeTheme: state.themeChange };
});
vi.mock("./components/MobileEntry", () => ({
  MobileEntry: ({ onRemote }: { onRemote: () => void }) => <button onClick={onRemote}>连接远程</button>,
}));
vi.mock("./components/SharedSessionPage", () => ({
  SharedSessionPage: ({ id }: { id: string }) => <div>分享 {id}</div>,
}));
vi.mock("./hooks/useMiniqApp", async () => {
  state.loadHarness();
  await state.harnessReady;
  return { useMiniqApp: state.useHarness };
});
vi.mock("./components/AppShell", () => ({
  AppShell: ({ theme, onThemeChange }: { theme: string; onThemeChange: (theme: string) => void }) => {
    const access = useSessionFileAccess();
    return <section aria-label="工作台" data-session={access?.sessionId} data-mode={access?.client?.mode} data-theme={theme}>
      <button onClick={() => onThemeChange("night")}>切换主题</button>
    </section>;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.remote = true;
  state.consent = true;
  state.share = null;
  state.loadCredentials.mockResolvedValue(null);
  state.useHarness.mockReturnValue({ client: { mode: "remote" }, catalog: { currentSessionId: "session-one" } });
});
afterEach(cleanup);

it("keeps the workbench module out of the entry screen and preserves context when it is requested", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "连接远程" });
  expect(state.loadHarness).not.toHaveBeenCalled();
  expect(state.useHarness).not.toHaveBeenCalled();
  state.loadCredentials.mockResolvedValue({ apiKey: "test-key" });
  fireEvent.click(screen.getByRole("button", { name: "连接远程" }));
  fireEvent.click(await screen.findByRole("button", { name: /测试电脑/ }));
  await screen.findByText("正在加载远程工作台…");
  await act(async () => state.releaseHarness());
  const workbench = await screen.findByRole("region", { name: "工作台" }, { timeout: 10_000 });
  expect(workbench.getAttribute("data-session")).toBe("session-one");
  expect(workbench.getAttribute("data-mode")).toBe("remote");
  expect(workbench.getAttribute("data-theme")).toBe("jade");
  fireEvent.click(screen.getByRole("button", { name: "切换主题" }));
  expect(state.themeChange).toHaveBeenCalledWith("night");
}, 20_000);

it("restores remembered credentials only after privacy consent", async () => {
  state.loadCredentials.mockResolvedValue({ apiKey: "test-key" });
  state.consent = false;
  const view = render(<App />);
  await screen.findByRole("button", { name: "连接远程" });
  expect(state.useHarness).not.toHaveBeenCalled();
  view.unmount();
  state.releaseHarness();
  state.consent = true;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /测试电脑/ }));
  await screen.findByRole("region", { name: "工作台" }, { timeout: 10_000 });
  expect(state.useHarness).toHaveBeenCalled();
}, 20_000);

it("keeps the entry screen usable when secure credential restoration fails", async () => {
  state.loadCredentials.mockRejectedValue(new Error("keychain unavailable"));
  render(<App />);
  await screen.findByRole("button", { name: "连接远程" });
  expect(state.useHarness).not.toHaveBeenCalled();
});

it("loads desktop workbench without reading mobile credentials", async () => {
  state.releaseHarness();
  state.remote = false;
  render(<App />);
  await screen.findByRole("region", { name: "工作台" }, { timeout: 10_000 });
  expect(state.loadCredentials).not.toHaveBeenCalled();
}, 20_000);

it("opens shared sessions without initializing a workbench or restoring credentials", async () => {
  state.share = "public-example";
  render(<App />);
  await screen.findByText("分享 public-example");
  expect(state.loadCredentials).not.toHaveBeenCalled();
  expect(state.useHarness).not.toHaveBeenCalled();
});

it("remounts discovery when either apiKey or relayUrl changes during credential loading", async () => {
  for (const changed of [{ apiKey: "second", relayUrl: "wss://one" }, { apiKey: "first", relayUrl: "wss://two" }]) {
    state.directoryMount.mockClear(); state.directoryUnmount.mockClear();
    state.loadCredentials.mockResolvedValueOnce(null);
    const view = render(<App />);
    const entry = await screen.findByRole("button", { name: "连接远程" });
    let first!: (value: object) => void, second!: (value: object) => void;
    state.loadCredentials.mockReturnValueOnce(new Promise((resolve) => { first = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { second = resolve; }));
    fireEvent.click(entry); fireEvent.click(entry);
    await act(async () => first({ apiKey: "first", relayUrl: "wss://one" }));
    await screen.findByRole("button", { name: /测试电脑/ });
    expect(state.directoryMount).toHaveBeenCalledTimes(1);
    await act(async () => second(changed));
    expect(state.directoryUnmount).toHaveBeenCalledTimes(1);
    expect(state.directoryMount).toHaveBeenCalledTimes(2);
    view.unmount();
  }
});
