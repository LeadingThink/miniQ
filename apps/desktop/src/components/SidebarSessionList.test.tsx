// @vitest-environment jsdom
import { useRef, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../types";
import { mockVirtualListLayout } from "../test/virtualListLayout";
import { handleSidebarNavigation } from "./SidebarNavigation";
import { SidebarSessionList } from "./SidebarSessionList";
import { ToastProvider } from "./ui/Toast";

const noop = () => undefined;
const sessions: Session[] = Array.from({ length: 150 }, (_, index) => ({
  id: `s${index}`,
  title: `会话 ${index}`,
  workspaceId: "project",
  workingDirectory: "/project",
  status: "idle",
  pinned: false,
  archived: false,
  createdAt: "2026-10-24",
  updatedAt: "2026-10-24",
}));
type Overrides = Partial<ComponentProps<typeof SidebarSessionList>>;
function Fixture({
  second = false,
  ...overrides
}: Overrides & { second?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const props = {
    sessions,
    currentSessionId: null,
    unreadSessionIds: new Set<string>(),
    scrollRef,
    contentRef,
    onSelectSession: noop,
    onSessionSeen: noop,
    onDeleteSession: noop,
    onRenameSession: noop,
    onSetSessionPinned: noop,
    onSetSessionArchived: noop,
    ...overrides,
  };
  return (
    <ToastProvider>
      <div
        ref={scrollRef}
        className="sidebar-scroll"
        onKeyDown={handleSidebarNavigation}
      >
        <div ref={contentRef}>
          <button className="workspace-select">项目一</button>
          <SidebarSessionList {...props} />
          {second && (
            <>
              <button className="workspace-select">项目二</button>
              <SidebarSessionList
                {...props}
                sessions={sessions.map((session) => ({
                  ...session,
                  id: `b${session.id}`,
                  title: `归档 ${session.title}`,
                }))}
                workspaceLabels={new Map([["project", "项目二"]])}
              />
            </>
          )}
        </div>
      </div>
    </ToastProvider>
  );
}
beforeEach(mockVirtualListLayout);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function scrollTo(top: number) {
  const scroll = document.querySelector<HTMLElement>(".sidebar-scroll")!;
  scroll.scrollTop = top;
  fireEvent.scroll(scroll);
}

it("navigates the full order across projects and archived lists", () => {
  render(<Fixture second />);
  const first = screen.getByRole("button", { name: "项目一" });
  fireEvent.keyDown(first, { key: "End" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "归档 会话 149" }),
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "项目二" }), {
    key: "ArrowUp",
  });
  const previous = screen.getByRole("button", { name: "会话 149" });
  expect(document.activeElement).toBe(previous);
  fireEvent.keyDown(previous, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "项目二" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "归档 会话 0" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(first);
});

it("keeps a rename draft mounted while its row scrolls out of view", () => {
  const onRenameSession = vi.fn();
  render(<Fixture onRenameSession={onRenameSession} />);
  fireEvent.click(screen.getByRole("button", { name: "会话 0 的更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole<HTMLInputElement>("textbox");
  fireEvent.change(input, { target: { value: "未丢失的草稿" } });
  scrollTo(100 * 36);
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input.value).toBe("未丢失的草稿");
  expect(document.querySelectorAll(".session-select").length).toBeLessThan(40);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onRenameSession).toHaveBeenCalledExactlyOnceWith("s0", "未丢失的草稿");
});

it("restores an optimistic deletion after scrolling away and undoing", () => {
  const onDeleteSession = vi.fn();
  render(<Fixture onDeleteSession={onDeleteSession} />);
  fireEvent.click(screen.getByRole("button", { name: "会话 0 的更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
  expect(screen.queryByRole("button", { name: "会话 0" })).toBeNull();
  scrollTo(100 * 36);
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  scrollTo(0);
  expect(screen.getByRole("button", { name: "会话 0" })).toBeTruthy();
  expect(onDeleteSession).not.toHaveBeenCalled();
});

it("leaves the active session immediately and restores it on undo", () => {
  const onDeleteSession = vi.fn();
  const onDeleteSessionStart = vi.fn();
  const onDeleteSessionUndo = vi.fn();
  render(
    <Fixture
      currentSessionId="s0"
      onDeleteSession={onDeleteSession}
      onDeleteSessionStart={onDeleteSessionStart}
      onDeleteSessionUndo={onDeleteSessionUndo}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "会话 0 的更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
  expect(onDeleteSessionStart).toHaveBeenCalledExactlyOnceWith("s0");
  expect(onDeleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(onDeleteSessionUndo).toHaveBeenCalledExactlyOnceWith("s0");
  expect(onDeleteSession).not.toHaveBeenCalled();
});

it("does not navigate when deleting a session that is not active", () => {
  const onDeleteSessionStart = vi.fn();
  const onDeleteSessionUndo = vi.fn();
  render(
    <Fixture
      currentSessionId="s1"
      onDeleteSessionStart={onDeleteSessionStart}
      onDeleteSessionUndo={onDeleteSessionUndo}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "会话 0 的更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(onDeleteSessionStart).not.toHaveBeenCalled();
  expect(onDeleteSessionUndo).not.toHaveBeenCalled();
});
