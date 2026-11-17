// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import type { DaemonEvent, Workspace } from "../types";
import type { RpcClient } from "../rpc";
import { parseBtwMessage } from "../sideConversation";
import { ComposerCard } from "./Composer";
import { SideConversationPanel, type SideConversationHandle } from "./SideConversationPanel";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const command = { id: "btw", name: "侧边追问", description: "侧边聊天", group: "会话", insertText: "/btw " };

it.each(["Enter", "button"])("routes the full question with %s while the main task is running", async (trigger) => {
  const onSend = vi.fn();
  const onSendSideMessage = vi.fn().mockResolvedValue(true);
  render(<ComposerCard busy placeholder="消息" onSend={onSend} onSendSideMessage={onSendSideMessage} slashCommands={[command]} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "/btw 解释当前代码\n保留第二行" } });
  await act(async () => {
    if (trigger === "Enter") fireEvent.keyDown(input, { key: "Enter" });
    else fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  });
  expect(onSendSideMessage).toHaveBeenCalledExactlyOnceWith("解释当前代码\n保留第二行", []);
  expect(onSend).not.toHaveBeenCalled();
  expect(input.value).toBe("");
});

it("keeps the original draft when side chat rejects the send", async () => {
  const onSend = vi.fn();
  const onSendSideMessage = vi.fn().mockResolvedValue(false);
  render(<ComposerCard busy={false} placeholder="消息" onSend={onSend} onSendSideMessage={onSendSideMessage} draftKey="btw" />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "/btw 保留问题" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(input.value).toBe("/btw 保留问题");
  expect(localStorage.getItem("miniq.draft.btw")).toBe("/btw 保留问题");
  expect(onSend).not.toHaveBeenCalled();
});

it("opens side chat for bare /btw without being swallowed by the slash menu", async () => {
  const side = vi.fn().mockResolvedValue(true);
  render(<ComposerCard busy={false} placeholder="消息" onSend={vi.fn()} onSendSideMessage={side} slashCommands={[command]} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "/btw" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(side).toHaveBeenCalledWith("", []);
});

it("does not send /btw to the main model when no side-chat entry is available", async () => {
  const onSend = vi.fn(); const onError = vi.fn();
  render(<ComposerCard busy={false} placeholder="消息" onSend={onSend} onError={onError} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "/btw 问题" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(onSend).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("先打开一个对话"));
  expect(input.value).toBe("/btw 问题");
});

it("forwards attachments and waits for acceptance before clearing the draft", async () => {
  localStorage.setItem("miniq.draft.btw-files.attachments", JSON.stringify(["/work/report.pdf"]));
  let finish!: (accepted: boolean) => void;
  const side = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const onSend = vi.fn();
  render(<ComposerCard busy={false} placeholder="消息" draftKey="btw-files" onSend={onSend} onSendSideMessage={side} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "/btw 看下附件" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(side).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(side).toHaveBeenCalledExactlyOnceWith("看下附件", ["/work/report.pdf"]);
  expect(input.value).toBe("/btw 看下附件");
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(side).toHaveBeenCalledOnce();
  await act(async () => finish(true));
  expect(input.value).toBe("");
  expect(localStorage.getItem("miniq.draft.btw-files.attachments")).toBeNull();
  expect(onSend).not.toHaveBeenCalled();
});

it.each(["/btwfile.png", "讨论 /btw 问题", "`/btw 问题`", "/btw/路径"])("preserves ordinary content: %s", (content) => {
  expect(parseBtwMessage(content)).toBeNull();
});

it("sends through the real side panel, reuses its session, and preserves its draft", async () => {
  const ref = createRef<SideConversationHandle>();
  let listener = (_event: DaemonEvent) => {};
  const session = { id: "side", workspaceId: "w", workingDirectory: "/work" };
  const snapshot = {
    session, messages: [],
    toolCalls: [], artifacts: [], plan: [], turnPlans: [], queue: [],
    approvals: [], questions: [], streamingText: "", streamingReasoning: "",
    turnProgress: null, goal: null, lastTurn: null, latestTurnTiming: null,
    processSummaries: [],
  };
  const call = vi.fn(async (method: string) => method === "session.fork" ? session : snapshot);
  const client = {
    call,
    onEvent: (fn: typeof listener) => { listener = fn; return () => {}; },
    onStatus: () => () => {},
    onResync: () => () => {},
  } as unknown as RpcClient;
  const workspace: Workspace = { id: "w", path: "/work", name: "项目", additionalPaths: [], createdAt: "now", updatedAt: "now" };
  render(<SideConversationPanel ref={ref} client={client} open workspace={workspace} sourceSessionId="main" onClose={() => {}} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "侧聊未发送草稿" } });
  let accepted = false;
  await act(async () => { accepted = await ref.current!.sendMessage({ sourceSessionId: "main", content: "问题", attachments: ["/work/test.png"] }); });
  expect(accepted).toBe(true);
  expect(call).toHaveBeenCalledWith("session.fork", { sessionId: "main", mode: "side" });
  expect(call).toHaveBeenCalledWith("session.sendMessage", { sessionId: "side", message: { role: "user", content: "问题", attachments: ["/work/test.png"] }, rejectIfBusy: true });
  expect(input.value).toBe("侧聊未发送草稿");
  await act(async () => { accepted = await ref.current!.sendMessage({ sourceSessionId: "main", content: "重复", attachments: [] }); });
  expect(accepted).toBe(false);
  act(() => listener({ type: "session_status_changed", sessionId: "side", status: "idle" }));
  await act(async () => { await ref.current!.sendMessage({ sourceSessionId: "main", content: "继续问", attachments: [] }); });
  expect(call.mock.calls.filter(([method]) => method === "session.fork")).toHaveLength(1);
  await waitFor(() => expect(call).toHaveBeenCalledWith("session.sendMessage", expect.objectContaining({ message: expect.objectContaining({ content: "继续问" }) })));
});
