// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonEvent, Message, Session, SessionForkInfo, Workspace } from "../types";
import { SideConversationPanel } from "./SideConversationPanel";

afterEach(() => {
  cleanup();
  localStorage.removeItem("miniq.sideConversationWidth");
});

const workspace = {
  id: "workspace-current",
  name: "miniQ",
  path: "D:\\study\\miniQ",
} as Workspace;

function fixture() {
  const listeners = new Set<(event: DaemonEvent) => void>();
  const session = { id: "side-session", workspaceId: workspace.id } as Session;
  const fork: SessionForkInfo = {
    sessionId: session.id,
    parentSessionId: "main-session",
    parentTitle: "主对话",
    anchorMessageId: "anchor-1",
    mode: "side",
    inheritedMessageCount: 12,
  };
  const messages: Message[] = [{
    id: "assistant-1",
    sessionId: session.id,
    role: "assistant",
    content: "这是侧边聊天回复",
    createdAt: new Date().toISOString(),
  }];
  let opens = 0;
  const call = vi.fn(async (method: string) => {
    if (method === "session.fork") return session;
    if (method === "session.open") {
      opens += 1;
      return opens === 1 ? { messages: [], fork } : { messages, fork };
    }
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
  it("forks the current conversation and renders its reply", async () => {
    const { client, call } = fixture();
    render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-session" onClose={() => {}} />);

    fireEvent.change(screen.getByRole("textbox", { name: "侧边聊天内容" }), { target: { value: "解释当前代码" } });
    fireEvent.click(screen.getByRole("button", { name: "发送侧边聊天" }));

    await waitFor(() => expect(call).toHaveBeenCalledWith("session.fork", {
      sessionId: "main-session",
      mode: "side",
    }));
    expect(call).not.toHaveBeenCalledWith("session.create", expect.anything());
    await waitFor(() => expect(call).toHaveBeenCalledWith("session.sendMessage", {
      sessionId: "side-session",
      message: { role: "user", content: "解释当前代码", attachments: [] },
      rejectIfBusy: true,
    }));
    expect(await screen.findByText("这是侧边聊天回复")).toBeTruthy();
    expect(await screen.findByText(/继承「主对话」/)).toBeTruthy();
  });

  it("sends selected files with the side message", async () => {
    const { client, call } = fixture();
    render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-session" onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "侧边聊天内容" }), { target: { value: "看这个文件" } });
    fireEvent.paste(screen.getByRole("textbox", { name: "侧边聊天内容" }), {
      clipboardData: { files: [new File(["png"], "shot.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("粘贴文件仅在 miniQ 桌面应用中可用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发送侧边聊天" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("session.sendMessage", expect.objectContaining({
      message: expect.objectContaining({ content: "看这个文件", attachments: [] }),
    })));
  });

  it("exposes a width separator for the side panel", () => {
    const { client } = fixture();
    render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-session" onClose={() => {}} />);
    const separator = screen.getByRole("separator", { name: "调整侧边聊天宽度" });
    expect(separator.getAttribute("aria-valuemin")).toBe("300");
    expect(separator.getAttribute("aria-valuemax")).toBe("760");
  });

  it("deletes the side session when the user releases it", async () => {
    const { client, call } = fixture();
    render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-session" onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "侧边聊天内容" }), { target: { value: "临时问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送侧边聊天" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "删除侧边聊天" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "删除侧边聊天" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("session.delete", { sessionId: "side-session" }));
  });

  it("releases the side conversation when the main conversation changes", async () => {
    const { client, call } = fixture();
    const view = render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-a" onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "侧边聊天内容" }), { target: { value: "这个侧聊会跟随主对话" } });
    fireEvent.click(screen.getByRole("button", { name: "发送侧边聊天" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("session.fork", expect.anything()));

    view.rerender(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId="main-b" onClose={() => {}} />);

    await waitFor(() => expect(call).toHaveBeenCalledWith("session.delete", { sessionId: "side-session" }));
  });

  it("keeps the input disabled until a main conversation is selected", () => {
    const { client } = fixture();
    render(<SideConversationPanel client={client as never} open workspace={workspace} sourceSessionId={null} onClose={() => {}} />);
    expect((screen.getByRole("textbox", { name: "侧边聊天内容" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText("先在主对话里打开一个会话。")).toBeTruthy();
  });
});
