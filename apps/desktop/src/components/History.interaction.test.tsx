// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import { ToolGroup } from "./ToolGroup";
import { useToolDetail } from "../hooks/useToolDetail";
import { useHistorySearch } from "../hooks/useHistorySearch";
import { Timeline } from "./Timeline";

afterEach(cleanup);
const tool: ToolCall = {id:"tool", sessionId:"session", toolName:"shell_run", input:null, status:"failed", createdAt:"2026-09-07", payloadDeferred:true};

it("keeps historical failures collapsed, paginates all steps and can collapse again", () => {
  render(<ToolGroup calls={Array.from({length:75}, (_, index) => ({...tool, id:`tool-${index}`}))} onRollback={vi.fn()} />);
  expect(document.querySelectorAll(".tool-step")).toHaveLength(0);
  const toggle = screen.getByRole("button", {name:/75 个执行步骤/});
  fireEvent.click(toggle);
  expect(document.querySelectorAll(".tool-step")).toHaveLength(30);
  fireEvent.click(screen.getByRole("button", {name:"下一页步骤"}));
  fireEvent.click(screen.getByRole("button", {name:"下一页步骤"}));
  expect(document.querySelectorAll(".tool-step")).toHaveLength(15);
  fireEvent.click(toggle);
  expect(document.querySelectorAll(".tool-step")).toHaveLength(0);
});

it("fetches a tool only on expansion, cancels on collapse and reuses a completed detail", async () => {
  let finish: (value: ToolCall) => void = () => {};
  const call = vi.fn(() => new Promise<ToolCall>((resolve) => {finish = resolve;}));
  const client = {call} as unknown as RpcClient;
  const hook = renderHook(({open}) => useToolDetail(client, tool, open), {initialProps:{open:false}});
  expect(call).not.toHaveBeenCalled();
  hook.rerender({open:true});
  const firstSignal = (call.mock.calls[0] as unknown as [string, unknown, {signal:AbortSignal}])[2].signal;
  hook.rerender({open:false});
  expect(firstSignal.aborted).toBe(true);
  hook.rerender({open:true});
  await act(async () => finish({...tool, payloadDeferred:false, output:{stdout:"full output"}}));
  expect(hook.result.current.call.output).toEqual({stdout:"full output"});
  hook.rerender({open:false});
  hook.rerender({open:true});
  expect(call).toHaveBeenCalledTimes(2);
});

it("searches on the server and resets pagination when the query changes", async () => {
  const call = vi.fn().mockResolvedValue({messages:[], toolCalls:[tool], nextCursor:{at:"older",id:"next"}});
  const client = {call} as unknown as RpcClient;
  const hook = renderHook(({query}) => useHistorySearch(client, "session", "all", query), {initialProps:{query:"first"}});
  await waitFor(() => expect(hook.result.current.page?.toolCalls).toHaveLength(1));
  act(() => hook.result.current.loadOlder());
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  hook.rerender({query:"second"});
  await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
  expect(call.mock.calls[2][1]).toMatchObject({query:"second", before:null});
});

it("keeps server matches with deferred tool payloads and searches older artifacts separately", async () => {
  const call = vi.fn().mockResolvedValue({ messages: [], toolCalls: [tool], nextCursor: null });
  const client = { call } as unknown as RpcClient;
  const noop = vi.fn();
  const asyncNoop = async () => undefined;
  render(<Timeline
    client={client}
    sessionId="session"
    messages={[{ id: "latest", sessionId: "session", role: "user", content: "latest request", createdAt: "2026-09-08" }]}
    toolCalls={[]}
    historyCursor={{ at: "2026-09-08", id: "latest" }}
    artifacts={[
      { id: "matching", sessionId: "session", path: "/work/needle.pdf", title: "needle.pdf", kind: "pdf", createdAt: "2026-09-06" },
      { id: "unrelated", sessionId: "session", path: "/work/other.pdf", title: "other.pdf", kind: "pdf", createdAt: "2026-09-08" },
    ]}
    approvals={[]}
    questions={[]}
    plan={[]}
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
  />);
  expect(screen.queryByRole("button", { name: "打开 needle.pdf" })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索当前会话" }), { target: { value: "needle" } });
  await waitFor(() => expect(document.querySelectorAll(".tool-step")).toHaveLength(1));
  expect(call.mock.calls[0][0]).toBe("session.history");
  expect(call.mock.calls[0][1]).toMatchObject({ query: "needle", filter: "all" });
  expect(screen.getByRole("button", { name: "打开 needle.pdf" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "打开 other.pdf" })).toBeNull();
  expect(screen.queryByText("没有匹配的记录")).toBeNull();
});

it("retries a failed search page with the same cursor without losing loaded matches", async () => {
  const cursor = { at: "2026-09-07", id: "tool" };
  const call = vi.fn()
    .mockResolvedValueOnce({ messages: [], toolCalls: [tool], nextCursor: cursor })
    .mockRejectedValueOnce(new Error("connection interrupted"))
    .mockResolvedValueOnce({ messages: [], toolCalls: [{ ...tool, id: "older" }], nextCursor: null });
  const client = { call } as unknown as RpcClient;
  const hook = renderHook(() => useHistorySearch(client, "session", "errors", ""));
  await waitFor(() => expect(hook.result.current.page?.toolCalls).toHaveLength(1));
  act(() => hook.result.current.loadOlder());
  await waitFor(() => expect(hook.result.current.error).toContain("connection interrupted"));
  expect(hook.result.current.page?.toolCalls).toHaveLength(1);
  act(() => hook.result.current.loadOlder());
  await waitFor(() => expect(hook.result.current.page?.toolCalls).toHaveLength(2));
  expect(call).toHaveBeenCalledTimes(3);
  expect(call.mock.calls[1][1]).toMatchObject({ before: cursor });
  expect(call.mock.calls[2][1]).toMatchObject({ before: cursor });
  expect(hook.result.current.error).toBeNull();
});
