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
import { AgentHistory } from "./AgentHistory";

afterEach(cleanup);
const client = (call: ReturnType<typeof vi.fn>) =>
  ({ call, onStatus: () => () => {} }) as unknown as RpcClient;

it("loads child message metadata lazily then complete messages on expansion", async () => {
  const call = vi.fn(async (method: string) =>
    method === "agent.message"
      ? { message: { content: "complete evidence" } }
      : {
          revision: 3,
          entries: [
            {
              index: 9,
              role: "tool",
              textCharacters: 1600000,
              toolCount: 0,
              imageCount: 0,
            },
          ],
          nextCursor: { revision: 3, before: 9 },
        },
  );
  render(
    <AgentHistory
      client={client(call)}
      sessionId="session"
      agentId="child"
      status="completed"
    />,
  );
  const summary = await screen.findByText("10. 工具结果 · 1,600,000 字符");
  expect(call).toHaveBeenCalledTimes(1);
  fireEvent.click(summary);
  await screen.findByText(/complete evidence/);
  expect(call.mock.calls[1][0]).toBe("agent.message");
  fireEvent.click(summary);
  await waitFor(() =>
    expect(screen.queryByText(/complete evidence/)).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "较早的子任务消息" }));
  await screen.findByText("第 2 页");
  fireEvent.click(screen.getByRole("button", { name: "刷新子任务历史" }));
  await screen.findByText("第 1 页");
});

it("cancels old session loads and displays recoverable checkpoint changes", async () => {
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
    .mockRejectedValueOnce(
      new Error("agent history changed; refresh from the latest checkpoint"),
    )
    .mockResolvedValue({ revision: 4, entries: [], nextCursor: null });
  const rpc = client(call);
  const view = render(
    <AgentHistory
      client={rpc}
      sessionId="one"
      agentId="child"
      status="completed"
    />,
  );
  view.rerender(
    <AgentHistory
      client={rpc}
      sessionId="two"
      agentId="child"
      status="completed"
    />,
  );
  expect(signal.aborted).toBe(true);
  await screen.findByRole("alert");
  await act(async () =>
    finish({
      revision: 3,
      entries: [
        {
          index: 1,
          role: "user",
          textCharacters: 1,
          toolCount: 0,
          imageCount: 0,
        },
      ],
      nextCursor: null,
    }),
  );
  expect(screen.queryByText("2. 用户 · 1 字符")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新子任务历史" }));
  await screen.findByText("暂无子任务历史");
});
