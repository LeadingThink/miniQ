// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { GitPanel } from "./GitPanel";

afterEach(cleanup);

it("loads repository status and switches between worktree and staged diffs", async () => {
  const call = vi.fn((method: string, input: { staged?: boolean }) => {
    if (method === "git.status")
      return Promise.resolve({
        root: "/project",
        branch: "main...origin/main",
        entries: [
          { path: "src/app.ts", indexStatus: "M", worktreeStatus: "M" },
        ],
      });
    return Promise.resolve({ diff: input.staged ? "staged change" : "worktree change" });
  });
  render(
    <GitPanel
      client={{ call } as unknown as RpcClient}
      sessionId="session-1"
    />,
  );

  expect(await screen.findByText("worktree change")).toBeTruthy();
  expect(call).toHaveBeenCalledWith(
    "git.diff",
    { sessionId: "session-1", path: "src/app.ts", staged: false },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );

  fireEvent.click(screen.getByRole("button", { name: "暂存区" }));
  await waitFor(() => expect(screen.getByText("staged change")).toBeTruthy());
  expect(call).toHaveBeenCalledWith(
    "git.diff",
    { sessionId: "session-1", path: "src/app.ts", staged: true },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
