// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import { ExecutionFold } from "./ExecutionFold";
import { ToolGroup } from "./ToolGroup";
afterEach(cleanup);
it("loads no tool details on record expansion, including active steps, until a step is clicked", async () => {
  const calls: ToolCall[] = [
    { id: "a", sessionId: "s", toolName: "file_read", input: {}, status: "succeeded", createdAt: "2026-10-10T00:00:00Z", payloadDeferred: true },
    { id: "b", sessionId: "s", toolName: "shell_run", input: {}, status: "running", createdAt: "2026-10-10T00:00:00Z", payloadDeferred: true },
  ];
  const rpc = vi.fn(async () => ({ ...calls[1], payloadDeferred: false }));
  render(<ExecutionFold calls={calls} active><ToolGroup calls={calls} client={{ call: rpc } as unknown as RpcClient} onRollback={() => {}} /></ExecutionFold>);
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /正在运行命令/ }));
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  expect(rpc).toHaveBeenCalledWith("tool.detail", { sessionId: "s", toolCallId: "b" }, { signal: expect.any(AbortSignal) });
});
