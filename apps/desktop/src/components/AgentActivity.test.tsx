// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { AgentActivity } from "./AgentActivity";

afterEach(cleanup);
const client = (call: ReturnType<typeof vi.fn>) =>
  ({ call, onStatus: () => () => {} }) as unknown as RpcClient;
const step = {
  id: "t",
  sessionId: "s",
  agentId: "child",
  toolName: "file_read",
  input: null,
  payloadDeferred: true,
  status: "succeeded",
  createdAt: "2026-09-09T00:00:00Z",
};

it("paginates only this child's steps and fetches payloads only when expanded", async () => {
  const cursor = { at: step.createdAt, id: step.id };
  const call = vi.fn((method, params) =>
    Promise.resolve(
      method === "tool.detail"
        ? {
            ...step,
            input: { path: "evidence.txt" },
            output: "verified result",
            payloadDeferred: false,
          }
        : {
            messages: [],
            toolCalls: [{ ...step, id: params.before ? "earlier" : "t" }],
            nextCursor: params.before ? null : cursor,
          },
    ),
  );
  render(
    <AgentActivity
      client={client(call)}
      sessionId="s"
      agentId="child"
      status="completed"
    />,
  );
  const open = await screen.findByRole("button", { name: /读取了文件/ });
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0][1]).toMatchObject({
    sessionId: "s",
    agentId: "child",
    limit: 20,
  });
  fireEvent.click(open);
  expect(await screen.findByText("verified result")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "较早的子任务步骤" }));
  await waitFor(() =>
    expect(
      call.mock.calls.filter(([method]) => method === "session.history"),
    ).toHaveLength(2),
  );
  expect(call.mock.calls.at(-1)?.[1].before).toEqual(cursor);
  expect(screen.queryByText("verified result")).toBeNull();
});

it("aborts a stale child page and keeps failures separate from another child", async () => {
  let finish!: (value: unknown) => void;
  let signal!: AbortSignal;
  const call = vi
    .fn()
    .mockImplementationOnce((_method, _params, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValue({ messages: [], toolCalls: [], nextCursor: null });
  const rpc = client(call);
  const view = render(
    <AgentActivity
      client={rpc}
      sessionId="s"
      agentId="child"
      status="completed"
    />,
  );
  view.rerender(
    <AgentActivity
      client={rpc}
      sessionId="s"
      agentId="other"
      status="completed"
    />,
  );
  expect(signal.aborted).toBe(true);
  await screen.findByText("暂无执行记录");
  await act(async () =>
    finish({ messages: [], toolCalls: [step], nextCursor: null }),
  );
  expect(screen.queryByRole("button", { name: /读取了文件/ })).toBeNull();
});
