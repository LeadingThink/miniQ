// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { HistoryPage, Message } from "../types";
import { Timeline, type TimelineProps } from "./Timeline";

const observers: IntersectionObserverCallback[] = [];
const noop = () => undefined;
const asyncNoop = async () => undefined;
const latest: Message = {
  id: "latest", sessionId: "session", role: "user", content: "最新消息",
  createdAt: "2026-09-20T00:00:00Z",
};
const cursor = { at: latest.createdAt, id: latest.id };

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function page(client: RpcClient, onLoadOlder: TimelineProps["onLoadOlder"] = asyncNoop, messages = [latest]) {
  return <Timeline
    client={client}
    sessionId="session"
    messages={messages}
    toolCalls={[]}
    historyCursor={cursor}
    onLoadOlder={onLoadOlder}
    approvals={[]}
    questions={[]}
    plan={[]}
    artifacts={[]}
    queue={[]}
    streamingText=""
    turnProgress={null}
    busy={false}
    onResolveApproval={noop}
    onResolveQuestion={noop}
    onRollback={noop}
    onOpenFile={noop}
    onOpenUrl={noop}
    onSteerQueued={asyncNoop}
    onRemoveQueued={asyncNoop}
    onUpdateQueued={asyncNoop}
    onRewrite={async () => true}
    onError={noop}
  />;
}

it("auto loads remote history near the top once per cursor without a regular older button", async () => {
  const call = vi.fn();
  const client = { mode: "remote", call } as unknown as RpcClient;
  const onLoadOlder = vi.fn().mockResolvedValue(undefined);
  const { container, rerender } = render(page(client, onLoadOlder));
  const timeline = container.querySelector(".timeline")!;
  Object.defineProperties(timeline, { scrollHeight: { value: 2000 }, clientHeight: { value: 300 } });
  act(() => observers.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(onLoadOlder).not.toHaveBeenCalled();
  rerender(page(client, onLoadOlder, [latest, { ...latest, id: "output", role: "assistant", content: "新输出" }]));
  expect(onLoadOlder).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.scroll(timeline, { target: { scrollTop: 250 } });
    fireEvent.scroll(timeline, { target: { scrollTop: 50 } });
    expect(screen.queryByRole("button", { name: "更早的记录" })).toBeNull();
  });
  expect(onLoadOlder).toHaveBeenCalledTimes(1);
  fireEvent.scroll(timeline, { target: { scrollTop: 0 } });
  expect(onLoadOlder).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "重试加载历史记录" })).toBeNull();
  expect(call.mock.calls.filter(([method]) => method === "session.history")).toEqual([]);
});

it("automatically pages remote search with its query and cursor near the top", async () => {
  const result: HistoryPage = { messages: [latest], toolCalls: [], nextCursor: cursor };
  const call = vi.fn((method: string, _params?: unknown): Promise<unknown> => {
    if (method === "voice.capabilities")
      return Promise.resolve({ transcribe: false, speak: false, transcribeModel: null, ttsModel: null });
    return Promise.resolve(result);
  });
  const client = { mode: "remote", call } as unknown as RpcClient;
  const onLoadOlder = vi.fn().mockResolvedValue(undefined);
  const { container } = render(page(client, onLoadOlder));
  const historyCalls = () => call.mock.calls.filter(([method]) => method === "session.history");
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索当前会话" }), { target: { value: "消息" } });
  await waitFor(() => expect(historyCalls()).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "更早的记录" }).hasAttribute("disabled")).toBe(false));
  expect(historyCalls()).toHaveLength(1);
  call.mockResolvedValueOnce({ messages: [{ ...latest, id: "older" }], toolCalls: [], nextCursor: null });
  const timeline = container.querySelector(".timeline")!;
  Object.defineProperties(timeline, { scrollHeight: { value: 2000 }, clientHeight: { value: 300 } });
  fireEvent.scroll(timeline, { target: { scrollTop: 250 } });
  await waitFor(() => expect(historyCalls()).toHaveLength(2));
  expect(historyCalls()[1][0]).toBe("session.history");
  expect(historyCalls()[1][1]).toMatchObject({ sessionId: "session", query: "消息", before: cursor });
  expect(onLoadOlder).not.toHaveBeenCalled();
});

it("offers retry only after an older-page failure and shows pending retry status", async () => {
  const client = { mode: "remote", call: vi.fn() } as unknown as RpcClient;
  let finish!: () => void;
  const onLoadOlder = vi.fn()
    .mockResolvedValueOnce({ error: { code: "INVALID_ARGUMENT", message: "历史暂时不可用" } })
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { container } = render(page(client, onLoadOlder));
  const timeline = container.querySelector(".timeline")!;
  Object.defineProperties(timeline, { scrollHeight: { value: 2000 }, clientHeight: { value: 300 } });
  expect(screen.queryByRole("button", { name: "重试加载历史记录" })).toBeNull();
  await act(async () => { fireEvent.scroll(timeline, { target: { scrollTop: 100 } }); });
  expect(screen.getByRole("alert").textContent).toContain("历史暂时不可用");
  fireEvent.scroll(timeline, { target: { scrollTop: 0 } });
  expect(onLoadOlder).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "重试加载历史记录" }));
  expect(onLoadOlder).toHaveBeenCalledTimes(2);
  await act(async () => { finish(); });
  expect(screen.queryByRole("button", { name: "重试加载历史记录" })).toBeNull();
  expect(screen.queryByText("正在加载更早的记录")).toBeNull();
  expect(screen.queryByRole("button", { name: "更早的记录" })).toBeNull();
});

it("keeps initial search failures retryable without showing normal pagination controls", async () => {
  const call = vi.fn((method: string): Promise<unknown> => method === "session.history"
    ? Promise.reject(new Error("搜索暂时不可用"))
    : Promise.resolve({ transcribe: false, speak: false }));
  render(page({ mode: "remote", call } as unknown as RpcClient));
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索当前会话" }), { target: { value: "消息" } });
  await screen.findByText("搜索暂时不可用");
  expect(screen.queryByRole("button", { name: "更早的记录" })).toBeNull();
  call.mockResolvedValue({ messages: [latest], toolCalls: [], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "重试搜索" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull());
  expect(screen.getByRole("group", { name: "搜索结果导航" })).toBeTruthy();
});

it("preserves the search older-results action and retries a failed search page", async () => {
  const result: HistoryPage = { messages: [latest], toolCalls: [], nextCursor: cursor };
  const call = vi.fn((method: string): Promise<unknown> => method === "session.history"
    ? Promise.resolve(result)
    : Promise.resolve({ transcribe: false, speak: false }));
  render(page({ mode: "remote", call } as unknown as RpcClient));
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索当前会话" }), { target: { value: "消息" } });
  const older = await screen.findByRole("button", { name: "更早的记录" });
  call.mockRejectedValueOnce(new Error("较早搜索结果不可用"));
  fireEvent.click(older);
  await screen.findByText("较早搜索结果不可用");
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();
  call.mockResolvedValueOnce({ messages: [{ ...latest, id: "older", content: "更早消息" }], toolCalls: [], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "重试加载历史记录" }));
  await screen.findByText("更早消息");
  expect(screen.getByRole("group", { name: "搜索结果导航" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重试加载历史记录" })).toBeNull();
});

it("recovers transient older-page failures without flashing an error", async () => {
  vi.useFakeTimers();
  try {
    const load = vi.fn().mockResolvedValueOnce({ error: new Error("network unavailable") }).mockResolvedValueOnce(undefined);
    const { container, unmount } = render(page({ mode: "remote", call: vi.fn() } as unknown as RpcClient, load));
    const timeline = container.querySelector(".timeline")!;
    expect(timeline.getAttribute("tabindex")).toBe("0");
    Object.defineProperties(timeline, { scrollHeight: { value: 2000 }, clientHeight: { value: 300 } });
    await act(async () => { fireEvent.scroll(timeline, { target: { scrollTop: 100 } }); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("正在加载更早的记录")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("正在加载更早的记录")).toBeNull();
    unmount();
  } finally { vi.useRealTimers(); }
});
