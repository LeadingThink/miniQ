// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Session, Workspace } from "../types";
import { Sidebar } from "./Sidebar";

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
        updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null }}
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
        updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null }}
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
        updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null }}
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
    updateState: { phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null },
    onCheckForUpdates: noop, onInstallUpdate: noop, onError: noop, ...overrides,
  };
}

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

  it("keeps hidden session controls unmounted and makes all sessions available on expansion", () => {
    const sessions = Array.from({ length: 400 }, (_, index) => ({ ...session, id: `s${index}`, title: `任务 ${index}` }));
    render(<Sidebar {...sidebarProps({ sessions })} />);
    expect(document.querySelectorAll(".session-select")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "展开 397 条会话" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(400);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(document.querySelectorAll(".session-select")).toHaveLength(3);
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
  function mobileViewport() {
    const media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal("matchMedia", () => media);
    return media;
  }

  it("makes title search available immediately and keeps less frequent actions accessible", () => {
    mobileViewport();
    const onShowSchedule = vi.fn();
    const onClose = vi.fn();
    render(<Sidebar {...sidebarProps({ onShowSchedule, onClose })} />);
    expect(screen.getByRole("textbox", { name: "筛选会话、项目或电脑" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "已安排" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多功能" }));
    fireEvent.click(screen.getByRole("button", { name: "已安排" }));
    expect(onShowSchedule).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "导入会话" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "技能" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起功能" }));
    expect(screen.queryByRole("button", { name: "技能" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭项目与会话侧栏" }));
    expect(onClose).toHaveBeenCalledOnce();
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
