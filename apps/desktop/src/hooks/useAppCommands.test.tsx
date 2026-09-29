// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "./useMiniqApp";
import { useAppCommands } from "./useAppCommands";
import { dispatchCommand } from "../shortcuts";
import type { Session, Workspace } from "../types";

afterEach(cleanup);

const ws: Workspace = { id: "w", path: "/w", additionalPaths: [], name: "w", createdAt: "", updatedAt: "" };
const session = (id: string, extra: Partial<Session> = {}) => ({
  id, workspaceId: "w", workingDirectory: "/w", title: id, status: "idle", pinned: false, archived: false,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: `2026-01-0${id.charCodeAt(0) - 96}T00:00:00Z`, ...extra,
}) as Session;

function fakeApp(currentSessionId: string) {
  const sessions = [session("a"), session("b", { status: "waiting_approval" }), session("c")];
  return {
    client: {},
    unreadSessionIds: new Set<string>(),
    markSessionUnread: vi.fn(),
    markAllSessionsRead: vi.fn(),
    setError: vi.fn(),
    feed: { plan: [], artifacts: [] },
    catalog: {
      workspaces: [ws],
      sessions,
      currentSessionId,
      currentSession: sessions.find((item) => item.id === currentSessionId),
    },
    navigation: {
      sidebarCollapsed: false,
      setSidebarCollapsed: vi.fn(),
      showSearch: false,
      setShowSearch: vi.fn(),
      setShowSettings: vi.fn(),
    },
    actions: {
      newChat: vi.fn(),
      openSession: vi.fn(() => Promise.resolve()),
      setSessionArchived: vi.fn(() => Promise.resolve()),
      setSessionPinned: vi.fn(() => Promise.resolve()),
    },
  } as unknown as MiniqAppController & { actions: Record<string, ReturnType<typeof vi.fn>> };
}

let result: ReturnType<typeof useAppCommands>;
function Harness({ app, active = true }: { app: MiniqAppController; active?: boolean }) {
  result = useAppCommands(app, active);
  return null;
}

it("routes miniq:command bus events through the shared runner", () => {
  const app = fakeApp("a");
  render(<Harness app={app} />);
  const actions = app.actions as unknown as Record<string, ReturnType<typeof vi.fn>>;

  act(() => dispatchCommand("newChat"));
  expect(actions.newChat).toHaveBeenCalled();
  act(() => dispatchCommand("settings"));
  expect(app.navigation.setShowSettings).toHaveBeenCalledWith(true);
  act(() => dispatchCommand("toggleSidebar"));
  expect(app.navigation.setSidebarCollapsed).toHaveBeenCalledWith(true);
  act(() => dispatchCommand("palette"));
  expect(app.navigation.setShowSearch).toHaveBeenCalledWith(true);
  act(() => dispatchCommand("showShortcuts"));
  expect(result.showShortcuts).toBe(true);
  act(() => dispatchCommand("nextAttention"));
  expect(actions.openSession).toHaveBeenLastCalledWith("b");
  act(() => dispatchCommand("togglePin"));
  expect(actions.setSessionPinned).toHaveBeenCalledWith("a", true);
  act(() => dispatchCommand("archiveSession"));
  expect(actions.setSessionArchived).toHaveBeenCalledWith("a", true);
  act(() => dispatchCommand("markUnread"));
  expect(app.markSessionUnread).toHaveBeenCalledWith("a");
  act(() => dispatchCommand("markAllRead"));
  expect(app.markAllSessionsRead).toHaveBeenCalled();
  act(() => dispatchCommand("nextSession"));
  expect(actions.openSession).toHaveBeenCalledTimes(2);
});

it("supports back/forward via history and mouse side buttons", () => {
  const first = fakeApp("a");
  const view = render(<Harness app={first} />);
  view.rerender(<Harness app={fakeApp("b")} />);
  const third = fakeApp("c");
  view.rerender(<Harness app={third} />);
  const actions = third.actions as unknown as Record<string, ReturnType<typeof vi.fn>>;
  act(() => { window.dispatchEvent(new MouseEvent("mouseup", { button: 3 })); });
  expect(actions.openSession).toHaveBeenLastCalledWith("b");
  act(() => dispatchCommand("forward"));
  expect(actions.openSession).toHaveBeenLastCalledWith("c");
  expect(result.runCommand("openSessionN", 0)).toBe(true);
});

it("ignores the bus while inactive", () => {
  const app = fakeApp("a");
  render(<Harness app={app} active={false} />);
  act(() => dispatchCommand("newChat"));
  expect((app.actions as unknown as Record<string, ReturnType<typeof vi.fn>>).newChat).not.toHaveBeenCalled();
});

it("handles every native-menu command id through miniq:command", async () => {
  const menuIds = [
    "newChat", "settings", "toggleSidebar", "palette", "find", "showShortcuts", "prevSession", "nextSession",
    "nextAttention", "archiveSession", "togglePin", "markUnread", "markAllRead", "back", "forward", "copyMarkdown",
  ] as const;
  const main = document.createElement("div");
  main.className = "main";
  main.dataset.appActive = "true";
  main.innerHTML = '<input data-session-search="true" />';
  document.body.append(main);
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const client = { call: vi.fn(() => Promise.resolve({ messages: [], toolCalls: [], nextCursor: null })) };

  const first = fakeApp("a");
  const view = render(<Harness app={first} />);
  const app = Object.assign(fakeApp("b"), { client, unreadSessionIds: new Set(["c"]) });
  view.rerender(<Harness app={app} />);
  for (const id of menuIds) {
    act(() => {
      window.dispatchEvent(new CustomEvent("miniq:command", { detail: { id } }));
    });
  }
  await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
  const actions = app.actions as unknown as Record<string, ReturnType<typeof vi.fn>>;
  expect(actions.newChat).toHaveBeenCalled();
  expect(app.navigation.setShowSettings).toHaveBeenCalledWith(true);
  expect(app.navigation.setSidebarCollapsed).toHaveBeenCalled();
  expect(app.navigation.setShowSearch).toHaveBeenCalled();
  expect(document.activeElement).toBe(main.querySelector("input"));
  expect(result.showShortcuts).toBe(true);
  expect(actions.setSessionArchived).toHaveBeenCalledWith("b", true);
  expect(actions.setSessionPinned).toHaveBeenCalledWith("b", true);
  expect(app.markSessionUnread).toHaveBeenCalledWith("b");
  expect(app.markAllSessionsRead).toHaveBeenCalled();
  // prev/next session, next attention, back and forward all open sessions.
  expect(actions.openSession.mock.calls.map(([id]) => id)).toEqual(["a", "c", "c", "a", "b"]);
  main.remove();
});

it("keydown and the bus reach the same runner", () => {
  const app = fakeApp("a");
  render(<Harness app={app} />);
  const actions = app.actions as unknown as Record<string, ReturnType<typeof vi.fn>>;
  act(() => { result.onShortcut({ id: "togglePin" }); });
  act(() => dispatchCommand("togglePin"));
  expect(actions.setSessionPinned).toHaveBeenCalledTimes(2);
});
