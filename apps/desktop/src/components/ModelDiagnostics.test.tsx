// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { reportedTokens, type ModelCallRecord } from "../modelDiagnostics";
import { ModelDiagnostics } from "./ModelDiagnostics";

afterEach(cleanup);
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
const record: ModelCallRecord = {
  id: "call-1",
  sessionId: "one",
  agentId: null,
  turnId: "turn-1",
  sourceMessageId: "msg-1",
  trace: { purpose: "task", step: 1, attempt: 2 },
  startedAt: "2026-09-09T01:00:00Z",
  completedAt: "2026-09-09T01:00:01Z",
  elapsedMs: 1000,
  status: "completed",
  request: {
    model: "requested-model",
    apiProtocol: "responses",
    reasoningEffort: "high",
    maxOutputTokens: null,
  },
  estimatedInputTokens: 50,
  advertisedContextTokens: 1_000_000,
  advertisedOutputTokens: 128_000,
  response: {
    model: "actual-model",
    responseId: "response-1",
    usage: {
      input_tokens: 60,
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 90 },
    },
    stopReason: "completed",
  },
  error: null,
};
const client = (call: ReturnType<typeof vi.fn>) =>
  ({ call, onStatus: () => () => {} }) as unknown as RpcClient;

it("scopes child diagnostics and resets pending data when switching children", async () => {
  const call = vi.fn().mockResolvedValue({ calls: [], nextCursor: null });
  const rpc = client(call);
  const view = render(
    <ModelDiagnostics
      client={rpc}
      sessionId="one"
      agentId="child-a"
      onClose={vi.fn()}
    />,
  );
  await screen.findByText("暂无调用记录");
  expect(call.mock.calls[0][1]).toEqual({
    sessionId: "one",
    agentId: "child-a",
    before: null,
    limit: 20,
  });
  view.rerender(
    <ModelDiagnostics
      client={rpc}
      sessionId="one"
      agentId="child-b"
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call.mock.calls[1][1].agentId).toBe("child-b");
});

it("keeps unknown usage unknown and never sums reasoning into total output", () => {
  expect(reportedTokens(record)).toEqual({
    input: 60,
    output: 100,
    reasoning: 90,
  });
  expect(
    reportedTokens({
      ...record,
      response: { ...record.response, usage: null },
    }),
  ).toEqual({ input: null, output: null, reasoning: null });
  expect(
    reportedTokens({
      ...record,
      response: {
        ...record.response,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      },
    }),
  ).toEqual({ input: 0, output: 0, reasoning: null });
});

it("shows settings distinct from limits and pages without loading the whole session", async () => {
  const cursor = { at: record.startedAt, id: record.id };
  const call = vi
    .fn()
    .mockResolvedValueOnce({ calls: [record], nextCursor: cursor })
    .mockResolvedValueOnce({
      calls: [
        {
          ...record,
          id: "call-0",
          request: { ...record.request, model: "older-model" },
        },
      ],
      nextCursor: null,
    });
  render(
    <ModelDiagnostics
      client={client(call)}
      sessionId="one"
      onClose={vi.fn()}
    />,
  );
  await screen.findByText("requested-model");
  expect(screen.getByText("未设置")).toBeTruthy();
  expect(screen.getByText("100")).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "较早的调用" }));
  await screen.findByText("older-model");
  expect(screen.queryByText("requested-model")).toBeNull();
  expect(call.mock.calls[1][1]).toEqual({
    sessionId: "one",
    before: cursor,
    limit: 20,
  });
});

it("aborts stale requests and never renders another session's results", async () => {
  let resolve!: (value: unknown) => void;
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ calls: [], nextCursor: null });
  const connection = client(call);
  const view = render(
    <ModelDiagnostics client={connection} sessionId="one" onClose={vi.fn()} />,
  );
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  view.rerender(
    <ModelDiagnostics client={connection} sessionId="two" onClose={vi.fn()} />,
  );
  await screen.findByText("暂无调用记录");
  expect(call.mock.calls[0][2].signal.aborted).toBe(true);
  await act(async () => resolve({ calls: [record], nextCursor: null }));
  expect(screen.queryByText("requested-model")).toBeNull();
});

it("keeps failures local and supports retry", async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ calls: [], nextCursor: null });
  render(
    <ModelDiagnostics
      client={client(call)}
      sessionId="one"
      onClose={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "刷新调用记录" }));
  await screen.findByText("暂无调用记录");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("loads durable events only when selected and resets cursors between views", async () => {
  const call = vi.fn().mockImplementation(async (method: string) =>
    method === "session.executionEvents"
      ? {
          events: [
            {
              id: "event-1",
              sessionId: "one",
              createdAt: record.startedAt,
              type: "context_compacted",
              data: {
                agentId: "child",
                turnId: "turn-1",
                estimatedTokensBefore: 12000,
                estimatedTokensAfter: 4000,
              },
            },
          ],
          nextCursor: null,
        }
      : {
          calls: [record],
          nextCursor: { id: record.id, at: record.startedAt },
        },
  );
  render(
    <ModelDiagnostics
      client={client(call)}
      sessionId="one"
      agentId="child"
      onClose={vi.fn()}
    />,
  );
  await screen.findByText("requested-model");
  expect(call).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "较早的调用" }));
  await screen.findByText("第 2 页");
  fireEvent.click(screen.getByRole("button", { name: "执行事件" }));
  await screen.findByText("上下文压缩");
  expect(screen.getByText("估算 tokens：12,000 → 4,000")).toBeTruthy();
  expect(screen.getByText("第 1 页")).toBeTruthy();
  expect(call.mock.lastCall?.slice(0, 2)).toEqual([
    "session.executionEvents",
    { sessionId: "one", agentId: "child", before: null, limit: 20 },
  ]);
});
