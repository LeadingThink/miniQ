// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonEvent, Workspace } from "../types";
import type { RpcClient } from "../rpc";
import { SessionFileAccess } from "../sessionFileAccess";
import { SideConversationPanel } from "./SideConversationPanel";

const read = vi.hoisted(() => vi.fn());
vi.mock("../localFiles", async (original) => ({
  ...await original<typeof import("../localFiles")>(),
  readLocalFilePreview: read,
}));
beforeEach(() => {
  localStorage.setItem("miniq.sideConversation.local", JSON.stringify({ sessionId: "side", workspaceId: "w", sourceSessionId: "main", lastActivityAt: Date.now() }));
  read.mockReset().mockResolvedValue({ kind: "image", mimeType: "image/png", dataBase64: "AA==", content: null });
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:side-image");
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it.each([false, true])("reads side-chat images with its own session and working directory (streaming=%s)", async (streaming) => {
  const markdown = "![标记](images/marker.png)";
  let listener: (event: DaemonEvent) => void = () => {};
  const call = vi.fn(async () => ({
    session: { id: "side", workspaceId: "w", workingDirectory: "/work/task" },
    messages: streaming ? [] : [{ id: "reply", sessionId: "side", role: "assistant", content: markdown, createdAt: "2026-11-16" }],
  }));
  const client = { mode: "remote", call, onEvent: (fn: typeof listener) => { listener = fn; return () => {}; } } as unknown as RpcClient;
  const workspace: Workspace = {
    id: "w", name: "工作区", path: "/work", additionalPaths: ["/attached"],
    createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z",
  };
  render(<SessionFileAccess client={client} sessionId="main" workspacePath="/other" workspacePaths={["/other"]}>
    <SideConversationPanel client={client} open workspace={workspace} sourceSessionId="main" onClose={() => {}} />
  </SessionFileAccess>);
  await waitFor(() => expect(call).toHaveBeenCalledWith("session.open", expect.objectContaining({ sessionId: "side" })));
  if (streaming) act(() => listener({ type: "assistant_delta", sessionId: "side", messageId: "reply", delta: markdown }));
  await waitFor(() => expect(screen.getByRole("img", { name: "标记" }).getAttribute("src")).toBe("blob:side-image"));
  expect(read).toHaveBeenCalledWith("/work/task/images/marker.png", "/work/task", ["/work", "/attached"], expect.objectContaining({ client, sessionId: "side", signal: expect.any(AbortSignal) }), []);
  act(() => listener({ type: "assistant_delta", sessionId: "side", messageId: "reply", delta: "\n\n继续说明" }));
  expect(await screen.findByText("继续说明")).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
});
