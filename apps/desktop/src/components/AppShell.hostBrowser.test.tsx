// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { DaemonEvent } from "../types";
import { closeBrowser, openBrowser, setBrowserVisible } from "../browserWorkbench";

vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../hooks/useAppSlashCommands", () => ({ useAppSlashCommands: () => ({ commands: [], dialogs: null }) }));
vi.mock("./AppStatus", () => ({ AppStatusBar: () => null, AppErrorBanner: () => null }));
vi.mock("./Skills", () => ({ SkillsPanel: () => <p>Local skills view</p> }));
vi.mock("../browserWorkbench", async (original) => ({
  ...await original<typeof import("../browserWorkbench")>(),
  browserCapabilities: vi.fn(async () => ({
    navigationControl: true, domSnapshot: true, screenshot: false,
    tabs: true, pointerInput: true, keyboardInput: true, selectInput: true,
  })),
  openBrowser: vi.fn(async (url: string) => ({ url })),
  closeBrowser: vi.fn(async () => {}),
  resizeBrowser: vi.fn(async () => {}),
  setBrowserVisible: vi.fn(async () => {}),
  currentBrowser: vi.fn(async () => null),
  evaluateBrowser: vi.fn(async (viewId: string) => JSON.stringify(JSON.stringify({
    observationId: "fixture-observation", documentId: "fixture-document",
    tabId: viewId, url: "https://example.test/task", readyState: "complete",
    title: "Task page", items: [], textLines: ["Background task page"],
  }))),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(1400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 700, y: 80, width: 650, height: 800,
  } as DOMRect);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const events = new Set<(event: DaemonEvent) => void>();
  const call = vi.fn(async () => ({}));
  const newChat = vi.fn();
  const app = {
    client: {
      mode: "local", sshHost: null, call,
      onEvent: (listener: (event: DaemonEvent) => void) => {
        events.add(listener);
        return () => events.delete(listener);
      },
    },
    catalog: {
      currentSessionId: "same-session", selectedWorkspace: { id: "same-workspace" },
      currentWorkspace: { path: "/fixture" }, currentWorkspacePaths: ["/fixture"],
      workspaces: [], sessions: [],
    },
    navigation: {
      page: "skills", setShowSearch: vi.fn(), setShowSettings: vi.fn(),
      setSidebarCollapsed: vi.fn(), setPage: vi.fn(),
    },
    preview: { state: { open: false }, tabs: [], close: vi.fn() },
    review: { open: false, data: { files: [] }, setOpen: vi.fn() },
    actions: { newChat, cancelTurn: vi.fn() },
    feed: {}, busy: true, setError: vi.fn(),
  } as unknown as MiniqAppController;
  const emit = (operation: "tabs" | "snapshot", id: string) => {
    for (const listener of events) listener({
      type: "browser_driver_requested",
      request: {
        id, sessionId: "same-session", browserSessionId: "same-session",
        operation, arguments: {},
      },
    } as DaemonEvent);
  };
  return { app, call, newChat, events, emit };
}

it("keeps the real local browser and driver alive while its host is inactive", async () => {
  const fixture_ = fixture();
  const shell = (active: boolean) => <AppShell app={fixture_.app} theme="jade" onThemeChange={() => {}} contentOnly active={active} />;
  const view = render(shell(true));
  act(() => window.dispatchEvent(new CustomEvent("miniq:open-browser", {
    detail: { url: "https://example.test/task" },
  })));
  const browserElement = await screen.findByRole("complementary", { name: "网页浏览器" });
  await waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
  const viewId = vi.mocked(openBrowser).mock.calls[0][2];
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, true));
  const subscriptions = fixture_.events.size;
  expect(subscriptions).toBeGreaterThan(0);

  view.rerender(shell(false));
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, false));
  expect(view.container.querySelector(".browser-panel")).toBe(browserElement);
  expect(fixture_.events.size).toBe(subscriptions);
  expect(closeBrowser).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  expect(fixture_.newChat).not.toHaveBeenCalled();

  act(() => fixture_.emit("snapshot", "background-snapshot"));
  await waitFor(() => expect(fixture_.call).toHaveBeenCalledWith("browser.resolve", {
    requestId: "background-snapshot", result: expect.objectContaining({
      result: expect.objectContaining({ textLines: ["Background task page"] }),
    }),
  }));
  expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, false);
  expect(closeBrowser).not.toHaveBeenCalled();

  view.rerender(shell(true));
  await waitFor(() => expect(setBrowserVisible).toHaveBeenLastCalledWith(viewId, true));
  expect(view.container.querySelector(".browser-panel")).toBe(browserElement);
  expect(openBrowser).toHaveBeenCalledOnce();
  expect(closeBrowser).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  expect(fixture_.newChat).toHaveBeenCalledOnce();
});
