// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Session, Workspace } from "../types";
import { Sidebar } from "./Sidebar";
import { mockVirtualListLayout } from "../test/virtualListLayout";

const noop = () => undefined;
const workspace: Workspace = {
  id: "workspace-1",
  name: "miniQ",
  path: "/work/miniq",
  additionalPaths: [],
  createdAt: "2026-09-03T00:00:00Z",
  updatedAt: "2026-09-03T00:00:00Z",
};
const session: Session = {
  id: "session-1",
  workspaceId: workspace.id,
  workingDirectory: workspace.path,
  title: "完善预览",
  status: "running",
  pinned: false,
  archived: false,
  createdAt: "2026-09-03T00:00:00Z",
  updatedAt: "2026-09-03T00:00:00Z",
};

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Sidebar", () => {
  it("starts with navigation on desktop and keeps the mobile drawer header", () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", () => media);
    const view = render(<Sidebar {...sidebarProps()} />);
    expect(view.container.querySelector(".sidebar-brand-row")).toBeNull();
    act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    const header = view.container.querySelector<HTMLElement>(".sidebar-brand-row")!;
    expect(within(header).getByText("miniQ")).not.toBeNull();
    expect(within(header).queryByText("mQ")).toBeNull();
  });
  it("toggles all project sessions when the project is clicked repeatedly", () => {
    const onSelectWorkspace = vi.fn();
    render(
      <Sidebar
        workspaces={[workspace]}
        sessions={[session]}
        unreadSessionIds={new Set()}
        currentSessionId={session.id}
        selectedWorkspaceId={workspace.id}
        onNewChat={noop}
        onShowSearch={noop}
        onShowSchedule={noop}
        onImportSessions={noop}
        onSelectWorkspace={onSelectWorkspace}
        onCreateSession={noop}
        onDeleteWorkspace={noop}
        onRenameWorkspace={noop}
        onEditWorkspace={noop}
        onSelectSession={noop}
        onSessionSeen={noop}
        onDeleteSession={noop}
        onRenameSession={noop}
        onSetSessionPinned={noop}
        onSetSessionArchived={noop}
        onShowSkills={noop}
        onShowMcp={noop}
        onShowSettings={noop}
        updateSupported={false}
        updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null, busyReason: null, releaseNotes: [] }}
        onCheckForUpdates={noop}
        onInstallUpdate={noop}
        onError={noop}
      />,
    );

    const projectButton = screen.getByRole("button", { name: workspace.name });
    expect(projectButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).not.toBeNull();

    fireEvent.click(projectButton);
    expect(projectButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).toBeNull();

    fireEvent.click(projectButton);
    expect(projectButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).not.toBeNull();
    expect(onSelectWorkspace).toHaveBeenCalledTimes(2);
  });

  it("uses keyboard-operable controls for projects and sessions", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        workspaces={[workspace]}
        sessions={[session]}
        unreadSessionIds={new Set()}
        currentSessionId={session.id}
        selectedWorkspaceId={workspace.id}
        onNewChat={noop}
        onShowSearch={noop}
        onShowSchedule={noop}
        onImportSessions={noop}
        onSelectWorkspace={noop}
        onCreateSession={noop}
        onDeleteWorkspace={noop}
        onRenameWorkspace={noop}
        onEditWorkspace={noop}
        onSelectSession={noop}
        onSessionSeen={noop}
        onDeleteSession={noop}
        onRenameSession={noop}
        onSetSessionPinned={noop}
        onSetSessionArchived={noop}
        onShowSkills={noop}
        onShowMcp={noop}
        onShowSettings={noop}
        updateSupported={false}
        updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null, busyReason: null, releaseNotes: [] }}
        onCheckForUpdates={noop}
        onInstallUpdate={noop}
        onError={noop}
      />,
    );
    expect(html).toContain('class="workspace-select"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('class="session-select"');
    expect(html).toContain('aria-current="page"');
  });

  it("makes a completed background reply visibly unread", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        workspaces={[workspace]}
        sessions={[{ ...session, status: "idle" }]}
        unreadSessionIds={new Set([session.id])}
        currentSessionId={null}
        selectedWorkspaceId={workspace.id}
        onNewChat={noop}
        onShowSearch={noop}
        onShowSchedule={noop}
        onImportSessions={noop}
        onSelectWorkspace={noop}
        onCreateSession={noop}
        onDeleteWorkspace={noop}
        onRenameWorkspace={noop}
        onEditWorkspace={noop}
        onSelectSession={noop}
        onSessionSeen={noop}
        onDeleteSession={noop}
        onRenameSession={noop}
        onSetSessionPinned={noop}
        onSetSessionArchived={noop}
        onShowSkills={noop}
        onShowMcp={noop}
        onShowSettings={noop}
        updateSupported={false}
        updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null, busyReason: null, releaseNotes: [] }}
        onCheckForUpdates={noop}
        onInstallUpdate={noop}
        onError={noop}
      />,
    );
    expect(html).toMatch(/class="session-item[^\"]*unread/);
    expect(html).toContain('class="session-state-label unread"');
    expect(html).toContain(">新回复<");
  });
});

function sidebarProps(overrides: Partial<ComponentProps<typeof Sidebar>> = {}): ComponentProps<typeof Sidebar> {
  return {
    workspaces: [workspace], sessions: [session], unreadSessionIds: new Set(), currentSessionId: null,
    selectedWorkspaceId: workspace.id, onNewChat: noop, onShowSearch: noop, onShowSchedule: noop,
    onImportSessions: noop, onSelectWorkspace: noop, onCreateSession: noop, onDeleteWorkspace: noop,
    onRenameWorkspace: noop, onEditWorkspace: noop, onSelectSession: noop, onSessionSeen: noop,
    onDeleteSession: noop, onRenameSession: noop, onSetSessionPinned: noop, onSetSessionArchived: noop,
    onShowSkills: noop, onShowMcp: noop, onShowSettings: noop, updateSupported: false,
    updateState: { phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null, busyReason: null, releaseNotes: [] },
    onCheckForUpdates: noop, onInstallUpdate: noop, onError: noop, ...overrides,
  };
}

describe("desktop Sidebar footer", () => {
  it("keeps routine actions in the account menu and surfaces updates that need attention", () => {
    const onImportSessions = vi.fn();
    const onCheckForUpdates = vi.fn();
    const props = sidebarProps({ onImportSessions, onCheckForUpdates, updateSupported: true });
    const rendered = render(<Sidebar {...props} />);
    expect(screen.queryByRole("button", { name: "导入会话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "导入会话" }));
    expect(onImportSessions).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "检查更新" }));
    expect(onCheckForUpdates).toHaveBeenCalledOnce();
    rendered.rerender(<Sidebar {...props} updateState={{ phase: "available", version: "9.9.9", downloadedBytes: 0, totalBytes: null, error: null, busyReason: null, releaseNotes: [] }} />);
    expect(screen.getByRole("button", { name: "更新至 v9.9.9" })).not.toBeNull();
  });
});

describe("Sidebar navigation", () => {
  it("preserves project collapse across remounts and reveals a newly selected session", () => {
    const props = sidebarProps();
    const first = render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: workspace.name }));
    first.unmount();
    const next = render(<Sidebar {...props} />);
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).toBeNull();
    next.rerender(<Sidebar {...props} currentSessionId={session.id} />);
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).not.toBeNull();
  });


  it("keeps thousands of expanded sessions windowed and every index reachable", () => {
    mockVirtualListLayout();
    const sessions = Array.from({ length: 1500 }, (_, index) => ({ ...session, id: `s${index}`, title: `任务 ${index}` }));
    const onSelectSession = vi.fn();
    render(<Sidebar {...sidebarProps({ sessions, onSelectSession })} />);
    expect(document.querySelectorAll(".session-select")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "展开 1497 条会话" }));
    expect(document.querySelectorAll(".session-select").length).toBeLessThan(40);
    expect(document.querySelector('[data-virtualized="true"]')).not.toBeNull();
    const scroll = screen.getByRole("navigation", { name: "项目与会话" });
    scroll.scrollTop = 700 * 36;
    fireEvent.scroll(scroll);
    expect(screen.getByRole("button", { name: "任务 700，执行中" })).toBeTruthy();
    const project = screen.getByRole("button", { name: workspace.name });
    fireEvent.keyDown(project, { key: "End" });
    const last = screen.getByRole("button", { name: "任务 1499，执行中" });
    expect(document.activeElement).toBe(last);
    fireEvent.click(last);
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith("s1499");
    expect(document.querySelectorAll(".session-select").length).toBeLessThan(40);
    fireEvent.keyDown(last, { key: "Home" });
    expect(document.activeElement).toBe(project);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(3);
  });

  it("reveals a selected deep row and searches the complete data", () => {
    mockVirtualListLayout();
    const sessions = Array.from({ length: 1500 }, (_, index) => ({ ...session, id: `s${index}`, title: `任务 ${index}` }));
    const props = sidebarProps({ sessions, currentSessionId: "s1499" });
    const view = render(<Sidebar {...props} />);
    expect(screen.getByRole("button", { name: "任务 1499，执行中" }).getAttribute("aria-current")).toBe("page");
    expect(document.querySelectorAll(".session-select").length).toBeLessThan(40);
    fireEvent.click(screen.getByRole("button", { name: "筛选项目和会话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "筛选会话、项目或电脑" }), { target: { value: "任务 1498" } });
    expect(screen.getByRole("button", { name: "任务 1498，执行中" })).toBeTruthy();
    expect(document.querySelectorAll(".session-select")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "清除会话筛选" }));
    view.rerender(<Sidebar {...props} currentSessionId="s1200" />);
    expect(screen.getByRole("button", { name: "任务 1200，执行中" }).getAttribute("aria-current")).toBe("page");
  });

  it("reveals a selected session beyond the initial three without reopening on unrelated updates", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => ({ ...session, id: `s${index}`, title: `任务 ${index}` }));
    const props = sidebarProps({ sessions, currentSessionId: "s7" });
    const rendered = render(<Sidebar {...props} />);
    expect(screen.queryByRole("button", { name: "任务 7，执行中" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: workspace.name }));
    rendered.rerender(<Sidebar {...props} sessions={[...sessions]} />);
    expect(document.querySelectorAll(".session-select")).toHaveLength(0);
  });

  it("filters running, waiting, unread and pinned sessions without fetching history", () => {
    const sessions: Session[] = [session,
      { ...session, id: "waiting", title: "等待确认的任务", status: "waiting_approval" },
      { ...session, id: "unread", title: "后台回复", status: "idle", pinned: true },
      { ...session, id: "idle", title: "普通会话", status: "idle" }];
    render(<Sidebar {...sidebarProps({ sessions, unreadSessionIds: new Set(["unread"]) })} />);
    fireEvent.click(screen.getByRole("button", { name: "筛选项目和会话" }));
    fireEvent.click(screen.getByRole("button", { name: "进行中 2" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "等待确认的任务，等待确认" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "未读 1" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "后台回复，新回复" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "置顶 1" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(1);
  });

  it("finds archived titles and clears empty results with Escape", () => {
    const archived = { ...session, id: "archived", title: "归档报告", archived: true, status: "idle" as const };
    render(<Sidebar {...sidebarProps({ sessions: [session, archived] })} />);
    fireEvent.click(screen.getByRole("button", { name: "筛选项目和会话" }));
    const search = screen.getByRole("textbox", { name: "筛选会话、项目或电脑" });
    fireEvent.change(search, { target: { value: "归档报告" } });
    expect(screen.queryByRole("button", { name: "归档报告" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).toBeNull();
    fireEvent.change(search, { target: { value: "无结果" } });
    expect(screen.getByRole("status").textContent).toContain("没有符合条件");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "归档报告" })).toBeNull();
  });

  it("temporarily expands collapsed projects for matching titles without losing the preference", () => {
    render(<Sidebar {...sidebarProps()} />);
    fireEvent.click(screen.getByRole("button", { name: workspace.name }));
    fireEvent.click(screen.getByRole("button", { name: "筛选项目和会话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "筛选会话、项目或电脑" }), { target: { value: "预览" } });
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清除会话筛选" }));
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).toBeNull();
  });

  it("supports arrow, Home and End navigation without selecting sessions until activated", () => {
    const onSelectSession = vi.fn();
    render(<Sidebar {...sidebarProps({ onSelectSession })} />);
    const project = screen.getByRole("button", { name: workspace.name });
    const item = screen.getByRole("button", { name: "完善预览，执行中" });
    project.focus();
    fireEvent.keyDown(project, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item);
    expect(onSelectSession).not.toHaveBeenCalled();
    fireEvent.keyDown(item, { key: "Home" });
    expect(document.activeElement).toBe(project);
    fireEvent.keyDown(project, { key: "End" });
    expect(document.activeElement).toBe(item);
  });

  it("opens the archive when the current session is archived", () => {
    render(<Sidebar {...sidebarProps({ sessions: [{ ...session, archived: true }], currentSessionId: session.id })} />);
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).not.toBeNull();
  });

  it("reveals a current session when remote session metadata arrives after selection", () => {
    window.localStorage.setItem(`miniq.sidebar.project.${workspace.id}.collapsed`, "true");
    const props = sidebarProps({ currentSessionId: session.id });
    const rendered = render(<Sidebar {...props} sessions={[]} />);
    rendered.rerender(<Sidebar {...props} />);
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).not.toBeNull();
  });

  it("can close the filter controls while keeping the selected filter", () => {
    render(<Sidebar {...sidebarProps()} />);
    const toggle = screen.getByRole("button", { name: "筛选项目和会话" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "进行中 1" }));
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "筛选会话、项目或电脑" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "进行中 1" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("allows navigation and resizing when browser storage is denied", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    render(<Sidebar {...sidebarProps()} />);
    const separator = screen.getByRole("separator", { name: "调整左侧栏宽度" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("276");
    fireEvent.click(screen.getByRole("button", { name: workspace.name }));
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).toBeNull();
  });
});

describe("mobile Sidebar", () => {
  it("selects a session on the first focused touch without a preview", () => {
    mobileViewport();
    const onSelectSession = vi.fn();
    render(<Sidebar {...sidebarProps({ onSelectSession })} />);
    const button = screen.getByRole("button", { name: "完善预览，执行中" });
    fireEvent.pointerEnter(button, { pointerType: "touch" });
    fireEvent.pointerDown(button, { pointerType: "touch" });
    act(() => button.focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerUp(button, { pointerType: "touch" });
    fireEvent.click(button);
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes on a left swipe and leaves vertical list scrolling alone", () => {
    mobileViewport();
    const onClose = vi.fn();
    render(<Sidebar {...sidebarProps({ onClose })} />);
    const sidebar = document.querySelector(".sidebar")!;

    fireEvent.pointerDown(sidebar, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 260, clientY: 220 });
    fireEvent.pointerMove(sidebar, { pointerId: 1, pointerType: "touch", clientX: 185, clientY: 222 });
    fireEvent.pointerUp(sidebar, { pointerId: 1, pointerType: "touch", clientX: 170, clientY: 224 });
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    fireEvent.pointerDown(sidebar, { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: 260, clientY: 220 });
    fireEvent.pointerMove(sidebar, { pointerId: 2, pointerType: "touch", clientX: 252, clientY: 300 });
    fireEvent.pointerUp(sidebar, { pointerId: 2, pointerType: "touch", clientX: 248, clientY: 360 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on native touch events when a mobile WebView does not expose PointerEvents", () => {
    mobileViewport();
    const onClose = vi.fn();
    render(<Sidebar {...sidebarProps({ onClose })} />);
    const sidebar = document.querySelector(".sidebar")!;

    fireEvent.touchStart(sidebar, { touches: [{ identifier: 11, clientX: 260, clientY: 220 }] });
    fireEvent.touchMove(sidebar, { touches: [{ identifier: 11, clientX: 180, clientY: 222 }] });
    fireEvent.touchEnd(sidebar, { changedTouches: [{ identifier: 11, clientX: 165, clientY: 224 }] });
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    fireEvent.touchStart(sidebar, { touches: [{ identifier: 12, clientX: 260, clientY: 220 }] });
    fireEvent.touchMove(sidebar, { touches: [{ identifier: 12, clientX: 252, clientY: 300 }] });
    fireEvent.touchEnd(sidebar, { changedTouches: [{ identifier: 12, clientX: 248, clientY: 360 }] });
    expect(onClose).not.toHaveBeenCalled();
  });

  function mobileViewport() {
    const media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal("matchMedia", () => media);
    return media;
  }

  it("makes title search available immediately and keeps less frequent actions accessible", () => {
    mobileViewport();
    const onShowSchedule = vi.fn();
    const onShowSearch = vi.fn();
    const onShowSkills = vi.fn();
    const onClose = vi.fn();
    render(<Sidebar {...sidebarProps({ onShowSchedule, onShowSearch, onShowSkills, onClose })} />);
    expect(screen.getByRole("textbox", { name: "筛选会话、项目或电脑" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "技能中心" }));
    expect(onShowSkills).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "已安排" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多功能" }));
    fireEvent.click(screen.getByRole("button", { name: "搜索会话内容" }));
    expect(onShowSearch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "已安排" }));
    expect(onShowSchedule).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "导入会话" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "反馈" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "技能" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起功能" }));
    expect(screen.queryByRole("button", { name: "导入会话" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭项目与会话侧栏" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps one running filter in the tile and combines it with the search query", () => {
    mobileViewport();
    const otherWorkspace = { ...workspace, id: "other", name: "其他项目" };
    const sessions: Session[] = [session,
      { ...session, id: "waiting", title: "等待确认的任务", status: "waiting_approval" },
      { ...session, id: "idle", workspaceId: otherWorkspace.id, title: "普通会话", status: "idle" },
      { ...session, id: "archived", title: "归档任务", archived: true }];
    render(<Sidebar {...sidebarProps({ workspaces: [workspace, otherWorkspace], sessions })} />);
    const running = screen.getByRole("button", { name: "快捷筛选：进行中 2" });
    expect(screen.queryByRole("group", { name: "会话状态筛选" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全部 3" })).toBeNull();
    expect(running.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(running);
    expect(running.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".session-select")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: otherWorkspace.name })).toBeNull();
    const query = screen.getByRole("textbox", { name: "筛选会话、项目或电脑" });
    fireEvent.change(query, { target: { value: "完善预览" } });
    expect(document.querySelectorAll(".session-select")).toHaveLength(1);
    fireEvent.click(running);
    expect((query as HTMLInputElement).value).toBe("完善预览");
    expect(running.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "清除会话筛选" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "更多会话筛选" }));
    const filters = within(screen.getByRole("group", { name: "会话状态筛选" }));
    expect(filters.queryByRole("button", { name: /^(全部|进行中) / })).toBeNull();
    const waiting = filters.getByRole("button", { name: "待确认 1" });
    fireEvent.click(waiting);
    expect(waiting.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".session-select")).toHaveLength(1);
    fireEvent.click(running);
    expect(waiting.getAttribute("aria-pressed")).toBe("false");
    expect(running.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(waiting);
    fireEvent.click(waiting);
    expect(waiting.getAttribute("aria-pressed")).toBe("false");
    expect(running.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll(".session-select")).toHaveLength(3);
  });

  it("updates the running count when a task finishes and handles zero results", () => {
    mobileViewport();
    const props = sidebarProps({ sessions: [session, { ...session, id: "idle", title: "普通会话", status: "idle" }] });
    const view = render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "快捷筛选：进行中 1" }));
    view.rerender(<Sidebar {...props} sessions={props.sessions.map((item) => ({ ...item, status: "idle" }))} />);
    expect(screen.getByRole("button", { name: "快捷筛选：进行中 0" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".session-select")).toHaveLength(0);
    expect(screen.getByText("没有符合条件的会话")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "快捷筛选：进行中 0" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(2);
  });

  it("clears filtering and persists project collapse from the collapse-all control", () => {
    mobileViewport();
    render(<Sidebar {...sidebarProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "快捷筛选：进行中 1" }));
    const query = screen.getByRole("textbox", { name: "筛选会话、项目或电脑" });
    fireEvent.change(query, { target: { value: "完善预览" } });
    fireEvent.click(screen.getByRole("button", { name: "全部折叠" }));
    expect((query as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "快捷筛选：进行中 1" }).getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll(".session-select")).toHaveLength(0);
    expect(window.localStorage.getItem(`miniq.sidebar.project.${workspace.id}.collapsed`)).toBe("true");
  });

  it("preserves a filter when rotating between compact and desktop layouts", () => {
    const media = mobileViewport();
    render(<Sidebar {...sidebarProps()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "筛选会话、项目或电脑" }), { target: { value: "预览" } });
    act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
    expect(screen.getByRole("button", { name: "已安排" })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "筛选会话、项目或电脑" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "筛选项目和会话" }));
    expect((screen.getByRole("textbox", { name: "筛选会话、项目或电脑" }) as HTMLInputElement).value).toBe("预览");
    act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    expect((screen.getByRole("textbox", { name: "筛选会话、项目或电脑" }) as HTMLInputElement).value).toBe("预览");
  });

  it("dismisses the mobile keyboard on Search without clearing results or opening a session", () => {
    mobileViewport();
    const onSelectSession = vi.fn();
    render(<Sidebar {...sidebarProps({ onSelectSession })} />);
    const input = screen.getByRole("textbox", { name: "筛选会话、项目或电脑" });
    input.focus();
    fireEvent.change(input, { target: { value: "预览" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).not.toBe(input);
    expect(screen.getByRole("button", { name: "完善预览，执行中" })).not.toBeNull();
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("reveals a collapsed project during mobile search and preserves collapse after clearing", () => {
    mobileViewport();
    render(<Sidebar {...sidebarProps()} />);
    fireEvent.click(screen.getByRole("button", { name: workspace.name }));
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "筛选会话、项目或电脑" }), { target: { value: "预览" } });
    expect(screen.getByRole("button", { name: workspace.name }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "完善预览，执行中" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清除会话筛选" }));
    expect(screen.getByRole("button", { name: workspace.name }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "完善预览，执行中" })).toBeNull();
  });

  it("finds a remote computer, project path and full title using local catalog metadata", () => {
    mobileViewport();
    const remoteWorkspace = { ...workspace, id: "remote-workspace", name: "miniQ", path: "/srv/partner-project", additionalPaths: ["/srv/customer-assets"] };
    const title = "检查远程电脑里的企业路演宣传视频最终完整版并修复最后一页的中文标题";
    const remoteSession = { ...session, id: "remote-session", workspaceId: remoteWorkspace.id, title };
    const onSelectSession = vi.fn();
    render(<Sidebar {...sidebarProps({ workspaces: [workspace, remoteWorkspace], sessions: [session, remoteSession], onSelectSession,
      hostGroups: [{ key: "remote", label: "青岛设计工作站", state: "connected", workspaceIds: [remoteWorkspace.id], selected: false, onSelect: noop }] })} />);
    const query = screen.getByRole("textbox", { name: "筛选会话、项目或电脑" });
    for (const value of ["青岛设计", "customer-assets", "最后一页的中文标题"]) {
      fireEvent.change(query, { target: { value } });
      expect(document.querySelectorAll(".session-select")).toHaveLength(1);
      expect(screen.getByRole("button", { name: `${title}，执行中` }).textContent).toContain(title);
    }
    fireEvent.click(screen.getByRole("button", { name: `${title}，执行中` }));
    expect(onSelectSession).toHaveBeenCalledWith("remote-session");
  });

  it("isolates tasks requiring confirmation from running and failed tasks", () => {
    mobileViewport();
    render(<Sidebar {...sidebarProps({ sessions: [session,
      { ...session, id: "waiting", title: "允许发送", status: "waiting_approval" },
      { ...session, id: "failed", title: "需要恢复", status: "failed" },
      { ...session, id: "archived-failed", title: "旧错误", status: "failed", archived: true }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "更多会话筛选" }));
    fireEvent.click(screen.getByRole("button", { name: "待确认 1" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "允许发送，等待确认" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "失败 1" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "需要恢复，执行失败" })).not.toBeNull();
  });

  it("identifies the project and host of archived sessions", () => {
    mobileViewport();
    render(<Sidebar {...sidebarProps({ sessions: [{ ...session, archived: true }], currentSessionId: session.id,
      hostGroups: [{ key: "remote", label: "工作电脑", state: "connected", workspaceIds: [workspace.id], selected: true, onSelect: noop }] })} />);
    const control = screen.getByRole("button", { name: "完善预览，执行中" });
    const description = document.getElementById(control.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe("工作电脑 · miniQ");
  });
});


describe("project catalog feedback", () => {
  const host = { key: "local", label: "本机", state: "connected", workspaceIds: [] as string[], selected: true, onSelect: noop };
  it("only displays the empty-project prompt after a successful read", () => {
    const props = sidebarProps({ workspaces: [], sessions: [] });
    const view = render(<Sidebar {...props} hostGroups={[{ ...host, catalogStatus: "loading" }]} />);
    expect(screen.getByRole("status").textContent).toContain("正在加载项目");
    expect(screen.queryByText("还没有项目")).toBeNull();
    view.rerender(<Sidebar {...props} hostGroups={[{ ...host, catalogStatus: "error", catalogError: "读取超时", onRetry: noop }]} />);
    expect(screen.getByRole("alert").textContent).toContain("读取超时");
    expect(screen.queryByText("还没有项目")).toBeNull();
    view.rerender(<Sidebar {...props} hostGroups={[{ ...host, catalogStatus: "ready" }]} />);
    expect(screen.getByText("还没有项目")).not.toBeNull();
  });
  it("offers retry alongside cached projects and keeps it visible when filtering", () => {
    const onRetry = vi.fn();
    render(<Sidebar {...sidebarProps()} hostGroups={[{ ...host, workspaceIds: [workspace.id], catalogStatus: "error", catalogError: "读取超时", onRetry }]} />);
    expect(screen.getByRole("button", { name: workspace.name })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "筛选项目和会话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "筛选会话、项目或电脑" }), { target: { value: "无匹配项目" } });
    fireEvent.click(screen.getByRole("button", { name: "重试加载 本机 的项目" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).toContain("读取超时");
  });
  it("explains an offline host without showing an endless spinner or false empty state", () => {
    render(<Sidebar {...sidebarProps({ workspaces: [], sessions: [] })} hostGroups={[{ ...host, state: "disconnected", catalogStatus: "idle" }]} />);
    expect(screen.getByRole("status").textContent).toBe("连接电脑后加载项目");
    expect(screen.queryByText("正在加载项目…")).toBeNull();
    expect(screen.queryByText("还没有项目")).toBeNull();
  });
});
