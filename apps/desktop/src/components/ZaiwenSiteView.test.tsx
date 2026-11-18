// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildZaiwenSiteAuthScript, ZaiwenSiteView } from "./ZaiwenSiteView";

const state = vi.hoisted(() => ({
  action: vi.fn(),
  browser: { viewId: "zaiwen-view", activeUrl: "https://chat.zaiwenai.com/", loading: false, revision: 0, loadError: null, action: vi.fn(), setError: vi.fn() },
  listen: vi.fn(),
  evaluate: vi.fn(),
}));
const session = { token: "same-user-token", user: { uid: "user-1" } };
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../hooks/useBrowserPanel", () => ({ useBrowserPanel: () => state.browser }));
vi.mock("../browserEvents", () => ({ listenBrowserEvent: state.listen }));
vi.mock("../browserWorkbench", () => ({ evaluateBrowser: state.evaluate }));

beforeEach(() => {
  vi.clearAllMocks();
  state.listen.mockReturnValue(() => undefined);
  state.evaluate.mockResolvedValue("{\"ok\":true}");
  state.browser.action = state.action;
});
afterEach(() => cleanup());

describe("ZaiwenSiteView", () => {
  it("uses the main-site URL and injects the shared user token after load", async () => {
    render(<ZaiwenSiteView session={session} />);
    expect(screen.getByRole("main", { name: "在问主站" })).toBeTruthy();
    const onEvent = state.listen.mock.calls[0][2] as (event: { phase: string }) => void;
    onEvent({ phase: "finished" });
    await waitFor(() => expect(state.evaluate).toHaveBeenCalledWith("zaiwen-view", buildZaiwenSiteAuthScript(session.token)));
    await waitFor(() => expect(state.action).toHaveBeenCalledWith("reload"));
  });

  it("escapes the token and clears a stale site session id", () => {
    const script = buildZaiwenSiteAuthScript('a"b');
    expect(script).toContain('localStorage.setItem("token", "a\\"b")');
    expect(script).toContain('localStorage.removeItem("auth-session-id")');
  });
});
