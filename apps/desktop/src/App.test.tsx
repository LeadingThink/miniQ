// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { useSessionFileAccess } from "./sessionFileAccess";

const state = vi.hoisted(() => {
  let release!: () => void;
  return {
    remote: true,
    consent: true,
    share: null as string | null,
    loadCredentials: vi.fn(),
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
  fireEvent.click(screen.getByRole("button", { name: "连接远程" }));
  await screen.findByText("正在加载远程工作台…");
  await act(async () => state.releaseHarness());
  const workbench = await screen.findByRole("region", { name: "工作台" });
  expect(workbench.getAttribute("data-session")).toBe("session-one");
  expect(workbench.getAttribute("data-mode")).toBe("remote");
  expect(workbench.getAttribute("data-theme")).toBe("jade");
  fireEvent.click(screen.getByRole("button", { name: "切换主题" }));
  expect(state.themeChange).toHaveBeenCalledWith("night");
});

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
  await screen.findByRole("region", { name: "工作台" });
  expect(state.useHarness).toHaveBeenCalled();
});

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
  await screen.findByRole("region", { name: "工作台" });
  expect(state.loadCredentials).not.toHaveBeenCalled();
});

it("opens shared sessions without initializing a workbench or restoring credentials", async () => {
  state.share = "public-example";
  render(<App />);
  await screen.findByText("分享 public-example");
  expect(state.loadCredentials).not.toHaveBeenCalled();
  expect(state.useHarness).not.toHaveBeenCalled();
});
