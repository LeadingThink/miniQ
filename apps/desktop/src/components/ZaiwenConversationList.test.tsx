// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZaiwenConversationList } from "./ZaiwenConversationList";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { AppSidebar } from "./AppSidebar";
import { useZaiwenHistory } from "../hooks/useZaiwenHistory";
import { listZaiwenConversations, listZaiwenMessages } from "../zaiwenHistory";

vi.mock("../zaiwenHistory", async (original) => ({
  ...await original<typeof import("../zaiwenHistory")>(),
  listZaiwenConversations: vi.fn(), listZaiwenMessages: vi.fn(),
}));
const session = { token: "test-token", user: { uid: "owner", nick: "测试账号" } };
const first = { id: "one", title: "第一条主站会话", created: 1700000000 };
const second = { ...first, id: "two", title: "第二条主站会话" };
const onSelect = vi.fn(), onClose = vi.fn(), newChat = vi.fn(), openSession = vi.fn();
const workspace = { id: "local-project", name: "本地项目", path: "/work", additionalPaths: [], createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
const localSession = { id: "local-session", workspaceId: workspace.id, workingDirectory: "/work", title: "原有本地会话", status: "idle", pinned: false, archived: false, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt };
const app = { catalog: { workspaces: [workspace], sessions: [localSession], currentSessionId: localSession.id, selectedWorkspace: workspace },
  unreadSessionIds: new Set(), navigation: { setSidebarCollapsed: onClose }, updater: { supported: false, state: { phase: "idle" } },
  actions: { newChat, openSession, selectWorkspace: vi.fn() }, markSessionSeen: vi.fn(), setError: vi.fn(),
} as unknown as MiniqAppController;
function Harness() {
  const history = useZaiwenHistory(session, true);
  return <AppSidebar app={app} onNavigate={() => history.select(null)} conversationCounts={{ all: history.conversations.items.length }} conversationItems={(query, filter) =>
    <ZaiwenConversationList session={session} history={history} query={query} filter={filter} onSelect={onSelect} onLogin={() => {}} />} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listZaiwenConversations).mockResolvedValue({ items: [first, second], total: 2, cursor: null });
  vi.mocked(listZaiwenMessages).mockResolvedValue({ items: [], total: 0, cursor: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("uses the shared sidebar navigation, selected row and loaded-title filter", async () => {
  const { container } = render(<Harness />);
  const one = await screen.findByRole("button", { name: first.title });
  const two = screen.getByRole("button", { name: second.title });
  expect(container.querySelectorAll(".sidebar")).toHaveLength(1);
  expect(screen.queryByText("在问主站会话")).toBeNull();
  expect(screen.getByText("工作区与项目")).toBeTruthy();
  expect(one.querySelector(".session-status.idle")).toBeTruthy();
  expect(screen.getByRole("button", { name: `${first.title} 的更多操作` })).toBeTruthy();
  act(() => one.focus());
  fireEvent.keyDown(one, { key: "ArrowDown" });
  expect(document.activeElement).toBe(two);
  fireEvent.keyDown(two, { key: "Home" });
  expect(document.activeElement).toBe(one);
  fireEvent.click(two);
  await waitFor(() => expect(two.getAttribute("aria-current")).toBe("page"));
  expect(onSelect).toHaveBeenCalledOnce();
  expect(listZaiwenMessages).toHaveBeenCalledWith(session, second.id, null, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "筛选项目和会话" }));
  expect(screen.getByRole("button", { name: "全部 3" })).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("搜索标题、项目或电脑"), { target: { value: "第二条" } });
  expect(screen.queryByRole("button", { name: first.title })).toBeNull();
  expect(screen.getByRole("button", { name: second.title })).toBe(two);
});

it("uses the original row action menu and disables unavailable cloud mutations", async () => {
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: `${first.title} 的更多操作` }));
  for (const name of ["重命名", "置顶", "归档", "删除会话"]) {
    expect(screen.getByRole<HTMLButtonElement>("menuitem", { name }).disabled).toBe(true);
  }
  expect(screen.queryByRole("textbox", { name: "重命名" })).toBeNull();
});

it("loads the next page into the same conversation list", async () => {
  vi.mocked(listZaiwenConversations).mockResolvedValueOnce({ items: [first], total: 2, cursor: "next" })
    .mockResolvedValueOnce({ items: [second], total: 2, cursor: null });
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "加载更多会话" }));
  await screen.findByRole("button", { name: second.title });
  expect(screen.getByRole("button", { name: first.title })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载更多会话" })).toBeNull();
  expect(listZaiwenConversations).toHaveBeenLastCalledWith(session, "next", expect.any(AbortSignal));
});

it("can dismiss the narrow-layout drawer without changing the selected conversation", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(<Harness />);
  const one = await screen.findByRole("button", { name: first.title });
  fireEvent.click(one);
  fireEvent.click(screen.getByRole("button", { name: "关闭项目与会话侧栏" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(one.getAttribute("aria-current")).toBe("page");
});

it("preserves local sessions and original new-chat actions alongside the cloud rows", async () => {
  render(<Harness />);
  const one = await screen.findByRole("button", { name: first.title });
  const local = screen.getByRole("button", { name: "原有本地会话" });
  expect(screen.getByRole("button", { name: "本地项目" })).toBeTruthy();
  fireEvent.click(one);
  await waitFor(() => expect(one.getAttribute("aria-current")).toBe("page"));
  fireEvent.click(local);
  expect(openSession).toHaveBeenCalledWith(localSession.id);
  expect(one.getAttribute("aria-current")).toBeNull();
  fireEvent.click(one);
  fireEvent.click(screen.getByRole("button", { name: "新对话" }));
  expect(newChat).toHaveBeenCalledOnce();
  expect(one.getAttribute("aria-current")).toBeNull();
  expect(screen.getByRole("button", { name: "原有本地会话" })).toBe(local);
});
