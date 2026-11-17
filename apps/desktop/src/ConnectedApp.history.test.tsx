// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import ConnectedApp from "./ConnectedApp";
import type { ZaiwenSession } from "./zaiwenAuth";
import { dispatchCommand } from "./shortcuts";
import { COMPOSER_PLACEHOLDER } from "./composerInput";
import { saveSession } from "./sessionExport";

const state = vi.hoisted(() => ({
  mounts: vi.fn(), unmounts: vi.fn(), call: vi.fn(), browserPanel: vi.fn(),
  controller: { client: { mode: "local" }, catalog: { currentSessionId: "local-session" },
    navigation: { setSidebarCollapsed: vi.fn(), setShowSettings: vi.fn(), setShowSearch: vi.fn() }, actions: { newChat: vi.fn() }, setError: vi.fn() },
}));
const session: ZaiwenSession = { token: "test-token", user: { uid: "test-owner", nick: "在问用户" } };
vi.mock("./desktopHost", () => ({ useDesktopHost: () => ({ host: null, sidebarCollapsed: false }) }));
vi.mock("./hooks/useMiniqApp", () => ({ useMiniqApp: () => state.controller }));
vi.mock("./hooks/useBrowserPanel", () => ({ useBrowserPanel: state.browserPanel }));
vi.mock("./sessionExport", async (original) => ({
  ...await original<typeof import("./sessionExport")>(), saveSession: vi.fn().mockResolvedValue({ status: "cancelled" }),
}));
vi.mock("./components/AppMenuBar", () => ({ AppMenuBar: ({ platform, onPlatformChange }: { platform: string; onPlatformChange: (value: string) => void }) =>
  <button data-platform={platform} onClick={() => onPlatformChange(platform === "miniq" ? "zaiwen" : "miniq")}>切换平台</button> }));
vi.mock("./components/UnifiedSidebar", () => ({ UnifiedSidebar: ({ conversationItems, onNavigate }: { conversationItems?: (query: string, filter: "all") => ReactNode; onNavigate: () => void }) =>
  <aside aria-label="本地项目与会话"><button onClick={onNavigate}>本地项目会话</button><button onClick={() => { onNavigate(); state.controller.actions.newChat(); }}>新对话</button>
    {conversationItems?.("", "all")}</aside> }));
vi.mock("./components/AppShell", () => ({ AppShell: ({ active }: { active: boolean }) => {
  useEffect(() => { state.mounts(); return state.unmounts; }, []);
  return <section aria-label="本地工作台" data-active={String(active)}>本地会话内容<input aria-label="本地草稿" defaultValue="" /></section>;
} }));
vi.mock("./components/ZaiwenLoginDialog", () => ({ ZaiwenLoginDialog: ({ open, onLogin, onClose }: {
  open: boolean; onLogin: (session: ZaiwenSession) => void; onClose: () => void;
}) => open ? <div role="dialog" aria-label="登录在问"><button onClick={() => onLogin({ token: "test-token", user: { uid: "test-owner", nick: "在问用户" } })}>完成登录</button>
  <button onClick={onClose}>取消登录</button></div> : null }));

beforeAll(async () => { await import("./components/ZaiwenConversation"); });

let revision: number;
function reply(data: unknown, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ code: 0, data, next_cursor: null, ...extra }), { status: 200 });
}
beforeEach(() => {
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return values.size; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
  } satisfies Storage);
  localStorage.setItem("miniq.zaiwen.token", session.token);
  localStorage.setItem("miniq.zaiwen.user", JSON.stringify(session.user));
  revision = 1;
  Object.assign(state.controller.client, { call: state.call });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("user/token")) return reply(session.user);
    if (url.pathname.endsWith("config/model/chat/")) return reply([{ key: "model", label: "在问模型" }]);
    if (url.pathname.endsWith("ai/conversations")) return reply([{ id: "cloud", title: "我的主站会话", created: 1700000000 }], { total: 1 });
    if (url.pathname.endsWith("ai/messages")) return reply([
      { id: "question", role: "user", content: "云端提问", created: 1700000000 },
      { id: "answer", role: "assistant", content: `主站回复 ${revision}`, created: 1700000001 },
    ], { total: 2 });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("adds cloud conversations alongside local sessions only in cloud mode and preserves the original workspace", async () => {
  const { container } = render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  const draft = screen.getByRole("textbox", { name: "本地草稿" });
  fireEvent.change(draft, { target: { value: "未发送的本地内容" } });
  expect(screen.getByLabelText("本地项目与会话")).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "会话" })).toBeNull();
  expect(screen.queryByText("在问主站会话")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  fireEvent.click(await screen.findByRole("button", { name: "我的主站会话" }));
  await screen.findByText("主站回复 1");
  const main = screen.getByRole("main", { name: "在问会话" });
  expect(main.classList.contains("main")).toBe(true);
  expect(main.querySelector(".statusbar.app-toolbar")).toBeTruthy();
  expect(main.querySelector(".session-stage .conversation-view .message-entry.user .bubble.user")).toBeTruthy();
  expect(screen.getByRole("group", { name: "记录类型" })).toBeTruthy();
  expect(screen.getByRole("searchbox", { name: "搜索当前会话" })).toBeTruthy();
  expect(main.querySelector("select")).toBeNull();
  expect(main.querySelector(".session-model-controls")).toBeTruthy();
  expect(main.querySelector(".message-entry.assistant .bubble.assistant")).toBeTruthy();
  expect(screen.getByLabelText("本地项目与会话")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "本地草稿" })).toBeNull();
  expect(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER)).toBeTruthy();
  expect(screen.queryByText("仅查看主站聊天记录")).toBeNull();
  expect(screen.getByLabelText("本地工作台").getAttribute("data-active")).toBe("false");
  expect(state.mounts).toHaveBeenCalledOnce();
  expect(state.unmounts).not.toHaveBeenCalled();
  expect(container.querySelector("iframe")).toBeNull();
  expect(state.browserPanel).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  expect(screen.queryByRole("main", { name: "在问会话" })).toBeNull();
  expect(screen.queryByRole("button", { name: "我的主站会话" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "本地草稿" })).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe("未发送的本地内容");
  expect(state.unmounts).not.toHaveBeenCalled();

  revision = 2;
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  await screen.findByText("主站回复 2");
  expect(screen.queryByText("主站回复 1")).toBeNull();
  expect(state.call).not.toHaveBeenCalled();
  for (const [, init] of vi.mocked(fetch).mock.calls) expect(init?.method).toBe("GET");
  expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).sort())
    .toEqual(["miniq.zaiwen.token", "miniq.zaiwen.user"]);
});

it("requires login before switching, and cancellation leaves local conversations visible", async () => {
  localStorage.clear();
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  expect(screen.getByRole("dialog", { name: "登录在问" })).toBeTruthy();
  expect(screen.getByLabelText("本地项目与会话")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "会话" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  fireEvent.click(screen.getByRole("button", { name: "完成登录" }));
  await screen.findByRole("button", { name: "我的主站会话" });
  expect(screen.getByLabelText("本地项目与会话")).toBeTruthy();
  expect(screen.getByRole("button", { name: "切换平台" }).dataset.platform).toBe("zaiwen");
});

it("retries a failed cloud list without changing the local workspace", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply(session.user)).mockRejectedValueOnce(new Error("网络不可用"));
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  await screen.findByText("网络不可用");
  fireEvent.click(screen.getByRole("button", { name: "重试加载会话" }));
  await screen.findByRole("button", { name: "我的主站会话" });
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  expect(screen.getByLabelText("本地工作台").getAttribute("data-active")).toBe("true");
  expect(state.call).not.toHaveBeenCalled();
});

it("keeps the cloud shell when login expires and reloads records after reauthentication", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply(session.user))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "02401", msg: "expired" }), { status: 401 }));
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  await screen.findByRole("button", { name: "登录在问，查看会话" });
  expect(screen.queryByRole("button", { name: "我的主站会话" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "登录在问，查看会话" }));
  fireEvent.click(screen.getByRole("button", { name: "完成登录" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "登录在问，查看会话" })).toBeNull());
  await screen.findByRole("button", { name: "我的主站会话" });
});

it("keeps the original new-chat and local-session view available after entering the cloud platform", async () => {
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  const draft = screen.getByRole("textbox", { name: "本地草稿" });
  fireEvent.change(draft, { target: { value: "保留本地草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  await screen.findByRole("button", { name: "我的主站会话" });
  expect(screen.getByRole("textbox", { name: "本地草稿" })).toBe(draft);
  fireEvent.click(screen.getByRole("button", { name: "我的主站会话" }));
  await screen.findByText("主站回复 1");
  fireEvent.click(screen.getByRole("button", { name: "本地项目会话" }));
  expect(screen.queryByRole("main", { name: "在问会话" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "本地草稿" })).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe("保留本地草稿");
  expect(screen.getByRole("button", { name: "我的主站会话" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "我的主站会话" }));
  await screen.findByText("主站回复 1");
  fireEvent.click(screen.getByRole("button", { name: "新对话" }));
  expect(state.controller.actions.newChat).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox", { name: "本地草稿" })).toBe(draft);
  expect(screen.getByRole("button", { name: "切换平台" }).dataset.platform).toBe("zaiwen");
  expect(state.unmounts).not.toHaveBeenCalled();
});

it("continues a main-site conversation through its API using the shared miniQ composer", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith("config/model/chat/")) return reply([{ key: "model" }, { key: "deepseek-chat" }]);
    if (String(input).endsWith("ai/message/stream")) return new Response([
      { type: "user-message", conversation_id: "cloud", data: { id: "sent", role: "user", content: "请继续解释", created: 1700000002 } },
      { type: "streaming", conversation_id: "cloud", content: "正在续写" },
      { type: "assistant-message", conversation_id: "cloud", data: { id: "reply", role: "assistant", content: "这是继续会话的回复", created: 1700000003 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    return original(input, init);
  });
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  fireEvent.click(await screen.findByRole("button", { name: "我的主站会话" }));
  await screen.findByText("主站回复 1");
  const draft = screen.getByPlaceholderText<HTMLTextAreaElement>(COMPOSER_PLACEHOLDER);
  await waitFor(() => expect(screen.getByRole("button", { name: "选择模型和思考强度" }).textContent).toContain("model"));
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await screen.findByRole("option", { name: "model" });
  fireEvent.change(screen.getByRole("textbox", { name: "模型 ID" }), { target: { value: "deepseek" } });
  fireEvent.click(screen.getByRole("option", { name: "deepseek-chat" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "选择模型和思考强度" }).textContent).toContain("deepseek-chat"));
  fireEvent.change(draft, { target: { value: "请继续解释" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await screen.findByText("这是继续会话的回复");
  await waitFor(() => expect(draft.value).toBe(""));
  expect(screen.getByText("请继续解释")).toBeTruthy();
  expect(screen.getByRole("button", { name: "本地项目会话" })).toBeTruthy();
  const post = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("ai/message/stream"))!;
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({ conversation_id: "cloud", data: { content: "请继续解释", model: "deepseek-chat" } });
  expect(state.call).not.toHaveBeenCalled();
  expect(localStorage.getItem("miniq.draft.zaiwen.test-owner.cloud")).toBeNull();
  dispatchCommand("newChat");
  await waitFor(() => expect(screen.queryByRole("main", { name: "在问会话" })).toBeNull());
  expect(state.controller.actions.newChat).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox", { name: "本地草稿" })).toBeTruthy();
});

it("retains the cloud draft when the main site rejects sending", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input).endsWith("ai/message/stream")
    ? new Response(JSON.stringify({ code: "02402", msg: "点数不足" }), { status: 402 }) : original(input, init));
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  fireEvent.click(await screen.findByRole("button", { name: "我的主站会话" }));
  await screen.findByText("主站回复 1");
  await waitFor(() => expect(screen.getByRole("button", { name: "选择模型和思考强度" }).textContent).toContain("model"));
  const draft = screen.getByPlaceholderText<HTMLTextAreaElement>(COMPOSER_PLACEHOLDER);
  fireEvent.change(draft, { target: { value: "不要丢失的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await screen.findByText("点数不足");
  expect(draft.value).toBe("不要丢失的草稿");
  expect(screen.queryByText("不要丢失的草稿", { selector: ".md" })).toBeNull();
  expect(state.call).not.toHaveBeenCalled();
});

it("searches and filters cloud messages using the original miniQ timeline without calling the local daemon", async () => {
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  fireEvent.click(await screen.findByRole("button", { name: "我的主站会话" }));
  await screen.findByText("主站回复 1");
  fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
  expect(screen.getByRole<HTMLButtonElement>("menuitem", { name: /重命名/ }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitem", { name: /搜索和筛选会话/ }));
  expect(document.querySelector(".timeline-toolbar")?.getAttribute("data-search-open")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "回答" }));
  expect(screen.getByRole("button", { name: "回答" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("云端提问")).toBeTruthy();
  expect(screen.getByText("主站回复 1")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索当前会话" }), { target: { value: "不存在的词" } });
  expect(screen.getByText("没有匹配的记录")).toBeTruthy();
  expect(screen.queryByText("主站回复 1")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索当前会话" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  expect(screen.getByText("云端提问")).toBeTruthy();
  expect(screen.getByText("主站回复 1")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "修改消息" })).toBeNull();
  expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
  expect(state.call).not.toHaveBeenCalled();
});

it("restores a cloud draft on platform reentry while keeping the local draft separate", async () => {
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  const local = screen.getByRole("textbox", { name: "本地草稿" });
  fireEvent.change(local, { target: { value: "本地草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  fireEvent.click(await screen.findByRole("button", { name: "我的主站会话" }));
  await screen.findByText("主站回复 1");
  fireEvent.change(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), { target: { value: "主站草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  expect((screen.getByRole("textbox", { name: "本地草稿" }) as HTMLInputElement).value).toBe("本地草稿");
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  await screen.findByText("主站回复 1");
  expect(screen.getByPlaceholderText<HTMLTextAreaElement>(COMPOSER_PLACEHOLDER).value).toBe("主站草稿");
  expect(state.call).not.toHaveBeenCalled();
});

it("exports all cloud pages through the original timeline menu", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("ai/messages")) return url.searchParams.has("cursor")
      ? reply([{ id: "older", role: "user", content: "更早的提问", created: 1700000000 }], { total: 2 })
      : reply([{ id: "recent", role: "assistant", content: "最新回复", created: 1700000001 }], { total: 2, next_cursor: "older-page" });
    return original(input, init);
  });
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  fireEvent.click(await screen.findByRole("button", { name: "我的主站会话" }));
  await screen.findByText("最新回复");
  expect(screen.queryByText("更早的提问")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "导出 JSON" }));
  await waitFor(() => expect(saveSession).toHaveBeenCalledOnce());
  expect(vi.mocked(saveSession).mock.calls[0][0].messages.map((message) => message.content)).toEqual(["更早的提问", "最新回复"]);
  expect(state.call).not.toHaveBeenCalled();
});

it("retries cloud model loading from the original model controls", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let failed = false;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (!failed && String(input).endsWith("config/model/chat/")) {
      failed = true;
      throw new Error("模型暂时不可用");
    }
    return original(input, init);
  });
  render(<ConnectedApp theme="jade" onThemeChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "切换平台" }));
  fireEvent.click(await screen.findByRole("button", { name: "我的主站会话" }));
  await screen.findByText("模型暂时不可用");
  expect(screen.getAllByText("模型暂时不可用")).toHaveLength(1);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "选择模型和思考强度" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新读取模型配置" }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "选择模型和思考强度" }).disabled).toBe(false));
  expect(screen.queryByText("模型暂时不可用")).toBeNull();
  expect(state.call).not.toHaveBeenCalled();
});
