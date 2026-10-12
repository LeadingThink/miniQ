// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { useAgentSummary } from "./useAgentSummary";

afterEach(cleanup);

function Probe({ client, sessionId }: { client: RpcClient; sessionId: string }) {
  const { agents, error } = useAgentSummary(client, sessionId, false);
  return <output data-testid="summary">{agents.map((agent) => agent.agentId).join(",")}{error ?? ""}</output>;
}

describe("useAgentSummary", () => {
  it("does not publish a late response from an old session or host", async () => {
    let resolveOld!: (value: unknown) => void;
    const oldCall = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveOld = resolve; }));
    const newCall = vi.fn().mockResolvedValue({ agents: [{
      agentId: "new-child",
      parentId: null,
      name: "new",
      description: "new",
      status: "completed",
      model: null,
      createdAt: "2026-09-22T00:00:00Z",
      queuedMessages: 0,
      error: null,
    }] });
    const oldClient = { call: oldCall, onStatus: () => () => {} } as unknown as RpcClient;
    const newClient = { call: newCall, onStatus: () => () => {} } as unknown as RpcClient;
    const view = render(<Probe client={oldClient} sessionId="old" />);
    view.rerender(<Probe client={newClient} sessionId="new" />);
    await screen.findByText("new-child");
    expect(oldCall.mock.calls[0][2].signal.aborted).toBe(true);
    await act(async () => { resolveOld({ agents: [{ agentId: "old-child" }] }); });
    expect(screen.getByTestId("summary").textContent).toBe("new-child");
  });
});


it("defers the agent RPC while the feed is loading and cancels when disabled", async () => {
  const call = vi.fn().mockReturnValue(new Promise(() => {}));
  const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
  const hook = renderHook(({ ready }) => useAgentSummary(client, "a", false, ready), { initialProps: { ready: false } });
  expect(call).not.toHaveBeenCalled();
  hook.rerender({ ready: true });
  expect(call).toHaveBeenCalledExactlyOnceWith("agent.list", { sessionId: "a" }, { signal: expect.any(AbortSignal) });
  hook.rerender({ ready: false });
  expect(call.mock.calls[0][2].signal.aborted).toBe(true);
});

it("isolates two hosts with the same session ID and aborts on unmount", async () => {
  let finishOld!: (value: unknown) => void;
  const oldCall = vi.fn().mockReturnValue(new Promise((resolve) => { finishOld = resolve; }));
  const newCall = vi.fn().mockResolvedValue({ agents: [{ agentId: "new-host", status: "completed" }] });
  const first = { call: oldCall, onStatus: () => () => {} } as unknown as RpcClient;
  const second = { call: newCall, onStatus: () => () => {} } as unknown as RpcClient;
  const hook = renderHook(({ client }) => useAgentSummary(client, "same", false), { initialProps: { client: first } });
  await act(async () => hook.rerender({ client: second }));
  expect(oldCall.mock.calls[0][2].signal.aborted).toBe(true);
  await act(async () => finishOld({ agents: [{ agentId: "old-host" }] }));
  expect(hook.result.current.agents.map((agent) => agent.agentId)).toEqual(["new-host"]);
  hook.unmount();
  expect(newCall.mock.calls[0][2].signal.aborted).toBe(true);
});
