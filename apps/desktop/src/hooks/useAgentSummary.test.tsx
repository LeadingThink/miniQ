// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
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
    await act(async () => { resolveOld({ agents: [{ agentId: "old-child" }] }); });
    expect(screen.getByTestId("summary").textContent).toBe("new-child");
  });
});
