// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  mergeByTime, processKey, ProcessRecordsContext, withProcessPage, type ProcessLoad, type ProcessLoadResult,
} from "../processRecords";
import type { RpcClient } from "../rpc";
import type { HistoryCursor, HistoryPage, Message, ProcessSummary, ToolCall } from "../types";
import { Timeline } from "./Timeline";

const noop = () => undefined;
const asyncNoop = async () => undefined;
afterEach(cleanup);

const at = (second: number) => `2026-09-08T00:00:${String(second).padStart(2, "0")}Z`;
const message = (id: string, role: Message["role"], content: string, second: number, extra: Partial<Message> = {}): Message =>
  ({ id, sessionId: "s", role, content, createdAt: at(second), ...extra });
const tool = (id: string, second: number, status: ToolCall["status"] = "succeeded"): ToolCall =>
  ({ id, sessionId: "s", toolName: "shell_run", input: null, status, createdAt: at(second), payloadDeferred: true });

// What a visible page returns: the user message and the final reply of two turns.
const visible = [
  message("u1", "user", "第一个问题", 0, { turnTiming: { startedAt: at(0), elapsedMs: 98000, status: "completed" } }),
  message("a1", "assistant", "第一个回答", 6, { assistantKind: "final" }),
  message("u2", "user", "第二个问题", 60),
  message("a2", "assistant", "第二个回答", 61, { assistantKind: "final" }),
];
// The folded work of turn u1, oldest first. Pages of two arrive newest first.
const folded = {
  messages: [message("c1", "assistant", "我先看看", 2, { assistantKind: "commentary" })],
  toolCalls: [tool("t1", 1, "failed"), tool("t2", 3), tool("t3", 4), tool("t4", 5)],
};
const summary: ProcessSummary = {
  turnId: "u1", recordCount: 5, toolCallCount: 4, messageCount: 1,
  statusCounts: { failed: 1, succeeded: 3 }, fileWriteCount: 0, firstAt: at(1), lastAt: at(5),
};

function serverPage(before: HistoryCursor | null, limit = 2, records = folded): HistoryPage {
  const rows = [
    ...records.messages.map((value) => ({ kind: "m" as const, value, at: value.createdAt, id: value.id })),
    ...records.toolCalls.map((value) => ({ kind: "t" as const, value, at: value.createdAt, id: value.id })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const older = before ? rows.filter((row) => row.at < before.at) : rows;
  const page = older.slice(0, limit).reverse();
  const last = older.length > limit ? page[0] : null;
  return {
    messages: page.flatMap((row) => row.kind === "m" ? [row.value] : []),
    toolCalls: page.flatMap((row) => row.kind === "t" ? [row.value] : []),
    nextCursor: last ? { at: last.at, id: last.id } : null,
  };
}

type Server = (turnId: string | null, before: HistoryCursor | null) => Promise<HistoryPage>;

function Harness({ server, client, messages = visible, summaries = { u1: summary }, busy = false }: {
  server: Server; client?: RpcClient; messages?: Message[]; summaries?: Record<string, ProcessSummary>; busy?: boolean;
}) {
  const [state, setState] = useState<{ messages: Message[]; toolCalls: ToolCall[]; loads: Record<string, ProcessLoad> }>(
    { messages, toolCalls: [], loads: {} });
  const latest = useRef(state);
  latest.current = state;
  const inFlight = useRef(new Map<string, Promise<ProcessLoadResult>>());
  const load = useCallback((turnId: string | null): Promise<ProcessLoadResult> => {
    const key = processKey(turnId);
    const pending = inFlight.current.get(key);
    if (pending) return pending;
    const current = latest.current.loads[key];
    if (current?.complete) return Promise.resolve();
    const request = (async (): Promise<ProcessLoadResult> => {
      try {
        const page = await server(turnId, current?.cursor ?? null);
        setState((previous) => ({
          messages: mergeByTime(previous.messages, page.messages),
          toolCalls: mergeByTime(previous.toolCalls, page.toolCalls),
          loads: withProcessPage(previous.loads, key, page),
        }));
      } catch (error) {
        return { error };
      } finally {
        inFlight.current.delete(key);
      }
    })();
    inFlight.current.set(key, request);
    return request;
  }, [server]);
  const value = useMemo(() => ({ summaries, loads: state.loads, load }), [summaries, state.loads, load]);
  return <ProcessRecordsContext.Provider value={value}>
    <Timeline client={client} sessionId="s" messages={state.messages} toolCalls={state.toolCalls}
      approvals={[]} questions={[]} plan={[]} artifacts={[]} queue={[]} streamingText="" turnProgress={null}
      busy={busy} onResolveApproval={noop} onResolveQuestion={noop} onRollback={noop} onOpenFile={noop}
      onOpenUrl={noop} onSteerQueued={asyncNoop} onRemoveQueued={asyncNoop} onUpdateQueued={asyncNoop}
      onRewrite={async () => true} onError={noop} />
  </ProcessRecordsContext.Provider>;
}

const fold = () => document.querySelector("details.completed-process") as HTMLDetailsElement;
const open = () => fireEvent.click(fold().querySelector("summary")!);

it("renders a folded turn from its summary and fetches nothing until it is opened", () => {
  const server = vi.fn<Server>(async (_turn, before) => serverPage(before));
  render(<Harness server={server} />);
  const summaryRow = fold().querySelector("summary")!;
  expect(summaryRow.textContent).toBe("已工作 1分38秒 · 5 条记录 · 1 个失败");
  expect(screen.getByText("第一个回答")).toBeTruthy();
  expect(fold().querySelector("[data-lazy-body]")).toBeNull();
  expect(server).not.toHaveBeenCalled();
  // The turn without folded work has no fold.
  expect(document.querySelectorAll("details.completed-process")).toHaveLength(1);
});

it("shows progress while the first page loads, then pages a large fold on demand", async () => {
  let release!: (page: HistoryPage) => void;
  const server = vi.fn<Server>((_turn, before) => before
    ? Promise.resolve(serverPage(before))
    : new Promise<HistoryPage>((resolve) => { release = resolve; }));
  render(<Harness server={server} />);
  open();
  expect((await screen.findByRole("status", { name: "" })).textContent).toContain("正在加载工作过程… 已加载 0 / 共 5");
  expect(server).toHaveBeenCalledOnce();
  expect(server).toHaveBeenLastCalledWith("u1", null);
  await act(async () => release(serverPage(null)));
  const button = await screen.findByRole("button", { name: "加载更早的记录（已加载 2 / 共 5）" });
  expect(fold().querySelector("[data-search-records]")!.getAttribute("data-search-records")).toBe("tool:t3 tool:t4");
  fireEvent.click(button);
  await screen.findByRole("button", { name: "加载更早的记录（已加载 4 / 共 5）" });
  expect(server).toHaveBeenLastCalledWith("u1", expect.objectContaining({ id: "t3" }));
  fireEvent.click(screen.getByRole("button", { name: /加载更早的记录/ }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /加载更早的记录/ })).toBeNull());
  expect(server).toHaveBeenCalledTimes(3);
  // Every folded record arrived exactly once, oldest first.
  expect(fold().getAttribute("data-search-records")).toBe("tool:t1 message:c1 tool:t2 tool:t3 tool:t4");
  // Closing and reopening reuses what is loaded.
  open(); open();
  expect(server).toHaveBeenCalledTimes(3);
});

it("reports a failed fold load and retries the same page", async () => {
  const server = vi.fn<Server>()
    .mockRejectedValueOnce(new Error("连接中断"))
    .mockImplementation(async (_turn, before) => serverPage(before, 10));
  render(<Harness server={server} />);
  open();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("加载工作过程失败：连接中断");
  expect(server).toHaveBeenCalledOnce();
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  await waitFor(() => expect(fold().getAttribute("data-search-records")).toBe("tool:t1 message:c1 tool:t2 tool:t3 tool:t4"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(server).toHaveBeenCalledTimes(2);
  expect(server).toHaveBeenLastCalledWith("u1", null);
});

it("opens the fold and loads pages until the located record appears", async () => {
  const server = vi.fn<Server>(async (_turn, before) => serverPage(before));
  const client = {
    mode: "local",
    call: vi.fn(async (method: string) => {
      if (method !== "session.history") throw new Error(method);
      return { messages: [], toolCalls: [tool("t1", 1, "failed")], nextCursor: null };
    }),
  } as unknown as RpcClient;
  render(<Harness server={server} client={client} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索当前会话" }), { target: { value: "t1" } });
  const locate = await screen.findByRole("button", { name: /查看上下文/ }) as HTMLButtonElement;
  await waitFor(() => expect(locate.disabled).toBe(false));
  fireEvent.click(locate);
  await waitFor(() => expect(document.querySelector("[data-search-located]")).toBeTruthy(), { timeout: 3000 });
  // t1 is the oldest folded record: three pages of two had to load.
  expect(server).toHaveBeenCalledTimes(3);
  expect(fold().open).toBe(true);
  expect(fold().getAttribute("data-search-records")).toContain("tool:t1");
  // The record itself is revealed, inside the fold that was opened for it.
  expect(fold().contains(document.querySelector("[data-search-located]"))).toBe(true);
});

it("loads the newest records of a running turn without opening anything and folds the rest", async () => {
  const running = [visible[0], visible[1], visible[2]];
  const records = {
    messages: [],
    toolCalls: [10, 11, 12, 13, 14, 15].map((second) => tool(`r${second}`, 60 + second - 8)),
  };
  const summaries = {
    u2: { ...summary, turnId: "u2", recordCount: 6, toolCallCount: 6, messageCount: 0, statusCounts: { succeeded: 6 } },
  };
  const server = vi.fn<Server>(async (_turn, before) => serverPage(before, 4, records));
  render(<Harness server={server} messages={running} summaries={summaries} busy />);
  await waitFor(() => expect(server).toHaveBeenCalledWith("u2", null));
  // The newest four records are on screen at once; two older ones wait behind the fold.
  const earlier = await screen.findByText("上 2 条消息");
  expect(document.querySelector("[data-search-records='tool:r12 tool:r13 tool:r14 tool:r15']")).toBeTruthy();
  expect(server).toHaveBeenCalledOnce();
  fireEvent.click(earlier);
  fireEvent.click(await screen.findByRole("button", { name: "加载更早的记录（已加载 4 / 共 6）" }));
  await waitFor(() => expect(screen.queryByText(/上 \d+ 条消息/)).toBeNull());
  expect(server).toHaveBeenCalledTimes(2);
  expect(document.querySelector("[data-search-records='tool:r10 tool:r11 tool:r12 tool:r13 tool:r14 tool:r15']")).toBeTruthy();
});
