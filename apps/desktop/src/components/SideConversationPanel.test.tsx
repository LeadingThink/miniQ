// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonEvent, Message, Session, Workspace } from "../types";
import { SideConversationPanel } from "./SideConversationPanel";

afterEach(cleanup);

const workspace = {
  id: "workspace-current",
  name: "miniQ",
  path: "D:\\study\\miniQ",
} as Workspace;

function fixture() {
  const listeners = new Set<(event: DaemonEvent) => void>();
  const session = { id: "side-session", workspaceId: workspace.id } as Session;
  const messages: Message[] = [{
    id: "assistant-1",
    sessionId: session.id,
    role: "assistant",
    content: "这是临时聊天回复",
    createdAt: new Date().toISOString(),
  }];
  const call = vi.fn(async (method: string) => {
    if (method === "session.create") return session;
    if (method === "session.open") return { messages };
    return {};
  });
  return {
    call,
    client: {
      call,
      onEvent: (listener: (event: DaemonEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (event: DaemonEvent) => listeners.forEach((listener) => listener(event)),
  };
}

describe("SideConversationPanel", () => {
  it("creates a temporary session in the current workspace and renders its reply", async () => {
    const { client, call } = fixture();
    render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-session" onClose={() => {}} />);

    fireEvent.change(screen.getByRole("textbox", { name: "临时侧聊内容" }), { target: { value: "解释当前代码" } });
    fireEvent.click(screen.getByRole("button", { name: "发送临时侧聊" }));

    await waitFor(() => expect(call).toHaveBeenCalledWith("session.create", {
      workspaceId: workspace.id,
      title: "临时侧聊",
    }));
    expect(call).not.toHaveBeenCalledWith("session.create", expect.objectContaining({ sourceSessionId: expect.anything() }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("session.sendMessage", {
      sessionId: "side-session",
      message: { role: "user", content: "解释当前代码", attachments: [] },
      rejectIfBusy: true,
    }));
    expect(await screen.findByText("这是临时聊天回复")).toBeTruthy();
  });

  it("deletes the temporary session when the user releases it", async () => {
    const { client, call } = fixture();
    render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId={null} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "临时侧聊内容" }), { target: { value: "临时问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送临时侧聊" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "释放临时侧聊" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "释放临时侧聊" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("session.delete", { sessionId: "side-session" }));
  });

  it("keeps the temporary session when the main conversation changes", async () => {
    const { client, call } = fixture();
    const view = render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-a" onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "临时侧聊内容" }), { target: { value: "保留这个侧聊" } });
    fireEvent.click(screen.getByRole("button", { name: "发送临时侧聊" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("session.create", expect.anything()));

    view.rerender(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-b" onClose={() => {}} />);

    expect(call).not.toHaveBeenCalledWith("session.delete", { sessionId: "side-session" });
  });

});