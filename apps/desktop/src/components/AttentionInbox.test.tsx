// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { AttentionInbox, relativeTime } from "./AttentionInbox";
import { AppStatusBar } from "./AppStatus";
import { getAttentionItems, getSummary, recordAttentionItem } from "../companionInbox";

const openSession = vi.fn();
vi.mock("../desktopHost", () => ({ useDesktopHost: () => ({ openSession }) }));
vi.mock("./ApprovalInbox", () => ({ ApprovalInboxButton: () => <button type="button" aria-label="待审批总览" /> }));

const app = { actions: { openSession: vi.fn() } } as never;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  openSession.mockReset();
});

function statusApp() {
  return {
    client: { mode: "remote", sshHost: null },
    connection: { connected: true, phase: "connected", health: { ok: true, version: "test" } },
    navigation: { sidebarCollapsed: false, setSidebarCollapsed: vi.fn(), openSettings: vi.fn(), setShowSettings: vi.fn() },
    catalog: { currentSession: null, currentWorkspace: null, currentSessionId: null, workspaces: [], sessions: [] },
    review: { data: { files: [], additions: 0, deletions: 0 } },
    preview: { viewScope: "workspace" },
    actions: { openSession: vi.fn() },
    setError: vi.fn(),
    busy: false,
  } as unknown as MiniqAppController;
}

it("renders the bell inside the toolbar actions next to the approval inbox", () => {
  recordAttentionItem({ host: "h", sessionId: "s1", kind: "completed", eventKey: "turn:t0", title: "完成", detail: "" });
  const { container } = render(
    <AppStatusBar app={statusApp()} showAttentionInbox onOpenBrowser={() => {}} onToggleReview={() => {}} onOpenFile={() => {}} />,
  );
  const actions = container.querySelector(".app-toolbar-actions")!;
  const bell = within(actions as HTMLElement).getByRole("button", { name: "提醒，1 条未读" });
  expect(bell.className).toContain("statusbar-icon-button");
  expect(bell.getAttribute("data-tooltip")).toBe("提醒");
  expect(bell.previousElementSibling?.getAttribute("aria-label")).toBe("待审批总览");
  expect(document.querySelector(".attention-inbox-anchor")).toBeNull();
});

it("hides the bell when the app is not active", () => {
  render(<AppStatusBar app={statusApp()} onOpenBrowser={() => {}} onToggleReview={() => {}} onOpenFile={() => {}} />);
  expect(screen.queryByRole("button", { name: /^提醒/ })).toBeNull();
});

it("opens a non-modal popover with an empty-state caption", () => {
  render(<AttentionInbox app={app} />);
  fireEvent.click(screen.getByRole("button", { name: "提醒" }));
  const popover = screen.getByRole("dialog", { name: "提醒" });
  expect(popover.className).toContain("ui-popover");
  expect(popover.getAttribute("aria-modal")).toBeNull();
  expect(within(popover).getByText("任务完成、失败或需要你处理时会出现在这里")).toBeTruthy();
});

it("navigates and marks read without implicit approval", () => {
  recordAttentionItem({ host: "remote-a", sessionId: "s1", kind: "approval", eventKey: "approval:a1", title: "部署", detail: "允许执行命令" });
  render(<AttentionInbox app={app} />);
  expect(screen.getByRole("button", { name: "提醒，1 条未读" }).textContent).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "提醒，1 条未读" }));
  expect(screen.getByText("去会话处理")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^部署/ }));
  expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ host: "remote-a", sessionId: "s1" }));
  expect(openSession).not.toHaveBeenCalledWith(expect.objectContaining({ approve: expect.anything() }));
  expect(getSummary().unread).toBe(0);
  expect(screen.queryByRole("dialog", { name: "提醒" })).toBeNull();
  expect(screen.getByRole("button", { name: "提醒" })).toBeTruthy();
});

it("routes local items through onOpenLocalItem and marks read only on success", () => {
  recordAttentionItem({ host: null, sessionId: "s1", kind: "completed", eventKey: "turn:l1", title: "本机任务", detail: "" });
  const onOpenLocalItem = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<AttentionInbox app={app} onOpenLocalItem={onOpenLocalItem} />);
  fireEvent.click(screen.getByRole("button", { name: /^提醒/ }));
  fireEvent.click(screen.getByRole("button", { name: /^本机任务/ }));
  expect(getSummary().unread).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: /^本机任务/ }));
  expect(onOpenLocalItem).toHaveBeenCalledTimes(2);
  expect(getSummary().unread).toBe(0);
  expect(openSession).not.toHaveBeenCalled();
});

it("marks a single item read and updates the badge", () => {
  recordAttentionItem({ host: "h", sessionId: "s1", kind: "failed", eventKey: "turn:t1", title: "构建", detail: "失败" });
  render(<AttentionInbox app={app} />);
  fireEvent.click(screen.getByRole("button", { name: "提醒，1 条未读" }));
  fireEvent.click(screen.getByRole("button", { name: "标为已读" }));
  expect(screen.queryByRole("button", { name: "提醒，1 条未读" })).toBeNull();
  expect(document.querySelector(".attention-inbox-badge")).toBeNull();
});

it("marks all unread items read", () => {
  for (let index = 0; index < 3; index += 1) {
    recordAttentionItem({ host: "h", sessionId: `s${index}`, kind: "completed", eventKey: `turn:${index}`, title: `任务 ${index}`, detail: "" });
  }
  render(<AttentionInbox app={app} />);
  fireEvent.click(screen.getByRole("button", { name: "提醒，3 条未读" }));
  expect(screen.getByText("3 条未读")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "全部已读" }));
  expect(getSummary().unread).toBe(0);
  expect(screen.queryByRole("button", { name: "全部已读" })).toBeNull();
  expect(screen.getAllByRole("button", { name: /^任务 / })).toHaveLength(3);
});

it("snoozes an item for one hour", () => {
  recordAttentionItem({ host: "h", sessionId: "s1", kind: "question", eventKey: "q:1", title: "问题", detail: "" });
  render(<AttentionInbox app={app} />);
  fireEvent.click(screen.getByRole("button", { name: /^提醒/ }));
  const before = Date.now();
  fireEvent.click(screen.getByRole("button", { name: "稍后 1 小时" }));
  const item = getAttentionItems({ state: "snoozed" }).items[0];
  expect(item?.snoozeUntil).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
  expect(screen.queryByRole("button", { name: "稍后 1 小时" })).toBeNull();
});

it("caps the badge at 99+", () => {
  for (let index = 0; index < 120; index += 1) {
    recordAttentionItem({ host: "h", sessionId: `s${index}`, kind: "completed", eventKey: `turn:${index}`, title: `t${index}`, detail: "" });
  }
  render(<AttentionInbox app={app} />);
  expect(screen.getByRole("button", { name: "提醒，120 条未读" }).textContent).toBe("99+");
});

it("formats relative times", () => {
  const now = 1_000_000_000_000;
  expect(relativeTime(now - 10_000, now)).toBe("刚刚");
  expect(relativeTime(now - 3 * 60_000, now)).toBe("3 分钟前");
  expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2 小时前");
});
