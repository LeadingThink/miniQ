// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { DaemonEvent, Session, Workspace } from "../types";
import CompanionWindow from "./CompanionWindow";

const project = { id: "w", name: "Known", path: "/known/root" } as Workspace;
const task = { id: "s", workspaceId: "w", title: "Existing task", status: "running", updatedAt: "2026-01-01" } as Session;
function fixture(failSend = false) {
  let handler: ((event: DaemonEvent) => void) | undefined;
  const call = vi.fn(async (method: string) => {
    if (method === "workspace.list") return { workspaces: [project] };
    if (method === "session.list") return { sessions: [task] };
    if (method === "session.create") return { ...task, id: "new", status: "idle" };
    if (method === "session.sendMessage") { if (failSend) throw new Error("API key missing"); return {}; }
    throw new Error(`unexpected RPC: ${method}`);
  });
  const client = { connected: true, mode: "local", call, onStatus: () => () => {}, onEvent: (callback: (event: DaemonEvent) => void) => { handler = callback; return () => { handler = undefined; }; } } as unknown as RpcClient;
  return { client, call, event: (event: DaemonEvent) => handler?.(event) };
}
afterEach(cleanup);

it("requires an explicit project, creates/sends text, and routes known sessions with both IDs", async () => {
  const f = fixture(); const openMain = vi.fn(async () => {});
  render(<CompanionWindow client={f.client} initialPrefs={{ mode: "pet" }} openMain={openMain} />);
  fireEvent.click(screen.getByRole("button", { name: /展开任务输入/ }));
  await screen.findByRole("button", { name: /打开会话：Existing task/ });
  expect((screen.getByLabelText("本机项目") as HTMLSelectElement).value).toBe("");
  expect((screen.getByRole("button", { name: "发送任务" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /打开会话：Existing task/ }));
  expect(openMain).toHaveBeenCalledWith({ action: "session", sessionId: "s", workspaceId: "w" });
  fireEvent.change(screen.getByLabelText("本机项目"), { target: { value: "w" } });
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "执行真实任务" } });
  fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
  await screen.findByText("已发送到本机项目，输入已清空。");
  expect((screen.getByLabelText("任务内容") as HTMLTextAreaElement).value).toBe("");
  expect(f.call).toHaveBeenCalledWith("session.create", { workspaceId: "w" });
  expect(f.call).toHaveBeenCalledWith("session.sendMessage", expect.objectContaining({ sessionId: "new", message: { role: "user", content: "执行真实任务", attachments: [] } }));
  fireEvent.click(screen.getByRole("button", { name: "在主窗口语音输入" }));
  expect(openMain).toHaveBeenCalledWith({ action: "voice", workspaceId: "w", sessionId: "new" });
});
it("retains failed text and created ID through collapse; API key guidance opens main settings", async () => {
  const f = fixture(true); const openMain = vi.fn(async () => {});
  render(<CompanionWindow client={f.client} initialPrefs={{ mode: "dots" }} openMain={openMain} />);
  fireEvent.click(screen.getByRole("button", { name: /展开任务输入/ }));
  await screen.findByText("Known · /known/root");
  fireEvent.change(screen.getByLabelText("本机项目"), { target: { value: "w" } });
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "我的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
  await screen.findByText("API key missing");
  expect((screen.getByLabelText("任务内容") as HTMLTextAreaElement).value).toBe("我的草稿");
  fireEvent.click(screen.getByRole("button", { name: "缩回伙伴" }));
  await waitFor(() => expect(screen.queryByLabelText("任务内容")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /展开任务输入/ }));
  await screen.findByLabelText("任务内容");
  expect((screen.getByLabelText("任务内容") as HTMLTextAreaElement).value).toBe("我的草稿");
  expect((screen.getByLabelText("目标会话") as HTMLSelectElement).value).toBe("new");
  fireEvent.click(screen.getByRole("button", { name: "打开主窗口设置 / API Key" }));
  expect(openMain).toHaveBeenCalledWith({ action: "settings" });
});
it("only consumes inbox props visually and acknowledges after successful main navigation", async () => {
  const f = fixture(); const opened = vi.fn(); const openMain = vi.fn().mockRejectedValueOnce(new Error("main unavailable")).mockResolvedValueOnce(undefined);
  render(<CompanionWindow client={f.client} initialPrefs={{ mode: "pet" }} notices={[{ id: "n", sessionId: "s", workspaceId: "w", state: "needs_input", text: "请确认任务" }]} onNoticeOpened={opened} openMain={openMain} />);
  fireEvent.click(screen.getByRole("button", { name: /需要你确认，展开/ }));
  await screen.findByRole("button", { name: /请确认任务/ });
  fireEvent.click(screen.getByRole("button", { name: /请确认任务/ }));
  await screen.findByText("main unavailable"); expect(opened).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /请确认任务/ }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith("n"));
});

it("maps live approvals/questions, completion and inherited model updates without stealing focus", async () => {
  const f = fixture();
  render(<CompanionWindow client={f.client} initialPrefs={{ mode: "pet" }} />);
  fireEvent.click(screen.getByRole("button", { name: /展开任务输入/ }));
  await screen.findByRole("button", { name: /打开会话：Existing task/ });
  fireEvent.change(screen.getByLabelText("本机项目"), { target: { value: "w" } });
  fireEvent.change(screen.getByLabelText("目标会话"), { target: { value: "s" } });
  const input = screen.getByLabelText("任务内容"); input.focus();
  act(() => f.event({ type: "model_settings_changed", sessionId: "s", workspaceId: "w", settings: { model: "inherited-model", apiProtocol: "auto", reasoningEffort: null } }));
  expect(screen.getByText(/模型：inherited-model/)).toBeTruthy();
  act(() => f.event({ type: "question_requested", sessionId: "s", question: { id: "q1" } } as DaemonEvent));
  act(() => f.event({ type: "question_requested", sessionId: "s", question: { id: "q2" } } as DaemonEvent));
  act(() => f.event({ type: "question_resolved", sessionId: "s", questionId: "q1" } as DaemonEvent));
  expect(screen.getByRole("main").getAttribute("data-state")).toBe("needs_input");
  act(() => f.event({ type: "question_resolved", sessionId: "s", questionId: "q2" } as DaemonEvent));
  act(() => f.event({ type: "session_status_changed", sessionId: "s", status: "idle" }));
  expect(screen.getByRole("main").getAttribute("data-state")).toBe("ready");
  expect(document.activeElement).toBe(input);
  expect(f.call.mock.calls.map(([method]) => method)).toEqual(["workspace.list", "session.list"]);
});

it("restores accepted text after an asynchronous provider failure and opens existing settings", async () => {
  const f = fixture(); const openMain = vi.fn(async () => {});
  render(<CompanionWindow client={f.client} initialPrefs={{ mode: "pet" }} openMain={openMain} />);
  fireEvent.click(screen.getByRole("button", { name: /展开任务输入/ }));
  await screen.findByText("Known · /known/root");
  fireEvent.change(screen.getByLabelText("本机项目"), { target: { value: "w" } });
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "保留没有 Key 的任务" } });
  fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
  await screen.findByText("已发送到本机项目，输入已清空。");
  act(() => f.event({ type: "turn_failed", sessionId: "new", error: "No provider configured" }));
  await waitFor(() => expect((screen.getByLabelText("任务内容") as HTMLTextAreaElement).value).toBe("保留没有 Key 的任务"));
  expect(screen.getByRole("main").getAttribute("data-state")).toBe("failed");
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "" } });
  expect((screen.getByLabelText("任务内容") as HTMLTextAreaElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "打开主窗口设置 / API Key" }));
  expect(openMain).toHaveBeenCalledWith({ action: "settings" });
});

it("adapts persisted local notices, opens their exact session and marks read only after reveal", async () => {
  localStorage.clear();
  const { recordAttentionItem, getAttentionItems } = await import("../companionInbox");
  recordAttentionItem({ id: "local", host: null, sessionId: "s", kind: "question", eventKey: "q-local", title: "本机提醒", detail: "请确认本机结果" });
  recordAttentionItem({ id: "ssh", host: "remote", workspaceId: "w", sessionId: "s", kind: "question", eventKey: "q-ssh", title: "远程提醒", detail: "不能混入远程" });
  recordAttentionItem({ id: "relay", host: null, targetDeviceId: "remote-device", workspaceId: "w", sessionId: "s", kind: "completed", eventKey: "relay", title: "relay", detail: "不能混入relay" });
  const f = fixture();
  const openMain = vi.fn().mockRejectedValueOnce(new Error("reveal failed")).mockResolvedValueOnce(undefined);
  render(<CompanionWindow client={f.client} initialPrefs={{ mode: "pet" }} openMain={openMain} />);
  fireEvent.click(screen.getByRole("button", { name: /展开任务输入/ }));
  const notice = await screen.findByRole("button", { name: /请确认本机结果/ });
  expect(screen.queryByText(/不能混入/)).toBeNull();
  fireEvent.click(notice);
  await screen.findByText("reveal failed");
  expect(getAttentionItems().items.find((item) => item.id === "local")?.state).toBe("unread");
  fireEvent.click(notice);
  await waitFor(() => expect(getAttentionItems().items.find((item) => item.id === "local")?.state).toBe("read"));
  expect(openMain).toHaveBeenLastCalledWith({ action: "session", sessionId: "s", workspaceId: "w" });
  expect(screen.queryByRole("button", { name: /请确认本机结果/ })).toBeNull();
  localStorage.clear();
});
