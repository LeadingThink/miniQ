// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useZaiwenCommands } from "./useZaiwenCommands";
import type { MiniqAppController } from "./useMiniqApp";
import { dispatchCommand } from "../shortcuts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const app = { actions: { newChat: vi.fn() }, navigation: {
    sidebarCollapsed: false, setSidebarCollapsed: vi.fn(), setShowSettings: vi.fn(), setShowSearch: vi.fn(),
  } } as unknown as MiniqAppController;
  const navigate = vi.fn(), stop = vi.fn();
  const view = renderHook(() => useZaiwenCommands(app, navigate, stop, "cloud-view"));
  return { app, navigate, stop, ...view };
}

it("keeps sidebar toggling within the cloud view and returns to local navigation for new chat and settings", () => {
  const { app, navigate } = setup();
  act(() => dispatchCommand("toggleSidebar"));
  expect(app.navigation.setSidebarCollapsed).toHaveBeenCalledWith(true);
  expect(navigate).not.toHaveBeenCalled();
  act(() => dispatchCommand("newChat"));
  expect(navigate).toHaveBeenCalledOnce();
  expect(app.actions.newChat).toHaveBeenCalledOnce();
  act(() => dispatchCommand("settings"));
  expect(app.navigation.setShowSettings).toHaveBeenCalledWith(true);
  expect(navigate).toHaveBeenCalledTimes(2);
});

it("supports the shortcut dialog without leaving the cloud conversation", () => {
  const { result, navigate } = setup();
  act(() => dispatchCommand("showShortcuts"));
  expect(result.current.showShortcuts).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  act(() => result.current.closeShortcuts());
  expect(result.current.showShortcuts).toBe(false);
});

it.each(["Win32", "MacIntel", "Linux x86_64"])("routes native find and keyboard search to the cloud timeline on %s", (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const listener = vi.fn();
  window.addEventListener("miniq:session-toolbar-action", listener);
  const { navigate } = setup();
  act(() => dispatchCommand("find"));
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: platform === "MacIntel", ctrlKey: platform !== "MacIntel" })));
  expect(listener).toHaveBeenCalledTimes(2);
  for (const [event] of listener.mock.calls) expect(event.detail).toEqual({ sessionId: "cloud-view", action: "search" });
  expect(navigate).not.toHaveBeenCalled();
  window.removeEventListener("miniq:session-toolbar-action", listener);
});
