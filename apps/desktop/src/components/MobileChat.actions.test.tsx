// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MOBILE_CHAT_STORAGE_KEY } from "../mobileChatData";
import { MobileChat } from "./MobileChat";

vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <div>{children}</div> }));

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const modelRequest = (url: unknown) => String(url).endsWith("/models");
const doneResponse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`);
const catalog = { data: [{ id: "chat-model", model_type: "chat" }] };
const image = { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } };
const storedMessages = () => JSON.parse(localStorage.getItem(MOBILE_CHAT_STORAGE_KEY) ?? "[]") as Array<{
  id?: string; role: string; content: unknown; replyTo?: string;
}>;
const rows = () => screen.getAllByRole("article");

function controlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }));
  return { response, cancel,
    push: (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)),
    close: () => controller.close(),
  };
}

function seed(messages: unknown[]) {
  localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, JSON.stringify(messages));
}

function installFetcher(answer: () => Response = () => doneResponse("新的回答")) {
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url) ? json(catalog) : answer()));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function confirmDeletion(row: HTMLElement) {
  fireEvent.click(within(row).getByRole("button", { name: "删除" }));
  fireEvent.click(within(row).getByRole("button", { name: "确认删除" }));
}

async function send(text: string) {
  await waitFor(() => expect(screen.getByRole("button", { name: "问答模型" }).hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: "输入问题或任务" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("copies the complete Markdown source of either role without action or status text", async () => {
  const markdown = `# 完整答案\n\n${"保留全部内容，**不要截断**。\n".repeat(1200)}\n\`\`\`ts\nconst answer = 42;\n\`\`\``;
  seed([{ role: "user", content: "请保留 Markdown" }, { role: "assistant", content: markdown, status: "interrupted" }]);
  installFetcher();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  fireEvent.click(within(rows()[0]).getByRole("button", { name: "复制" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("请保留 Markdown"));
  fireEvent.click(within(rows()[1]).getByRole("button", { name: "复制" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(markdown));
  expect(within(rows()[1]).getByRole("button", { name: "已复制" })).toBeTruthy();
  await screen.findByText("chat-model");
});

it("copies every text part of an image message and disables copy for image-only messages", async () => {
  seed([
    { role: "user", content: [{ type: "text", text: "第一段 **说明**" }, image, { type: "text", text: "第二段\n细节" }] },
    { role: "user", content: [image] },
  ]);
  installFetcher();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  fireEvent.click(within(rows()[0]).getByRole("button", { name: "复制" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("第一段 **说明**\n第二段\n细节"));
  const imageCopy = within(rows()[1]).getByRole("button", { name: "复制" }) as HTMLButtonElement;
  expect(imageCopy.disabled).toBe(true);
  fireEvent.click(imageCopy);
  expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
  expect(within(rows()[1]).getByRole("button", { name: "删除" })).toBeTruthy();
  await screen.findByText("chat-model");
});

it("shows clipboard failure without claiming that the message was copied", async () => {
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("clipboard unavailable"));
  seed([{ role: "assistant", content: "需要手动复制的内容" }]);
  installFetcher();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  await screen.findByRole("button", { name: "复制失败" });
  expect(within(rows()[0]).getByRole("alert").textContent).toContain("复制失败");
  expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
  expect(storedMessages()[0].content).toBe("需要手动复制的内容");
});

it("cancels deletion and removes only the selected message when texts repeat", async () => {
  seed([
    { id: "first", role: "user", content: "重复内容" },
    { id: "answer", role: "assistant", content: "中间回答", replyTo: "first" },
    { id: "second", role: "user", content: "重复内容" },
  ]);
  installFetcher();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  fireEvent.click(within(rows()[2]).getByRole("button", { name: "删除" }));
  expect(storedMessages()).toHaveLength(3);
  fireEvent.click(within(rows()[2]).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  expect(screen.getAllByText("重复内容")).toHaveLength(2);
  confirmDeletion(rows()[2]);
  expect(screen.getAllByText("重复内容")).toHaveLength(1);
  expect(storedMessages().map((message) => message.id)).toEqual(["first", "answer"]);
  await screen.findByText("chat-model");
});

it("deletes a paginated older message without losing unloaded or newer history", async () => {
  seed(Array.from({ length: 80 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? "assistant" : "user", content: `历史消息 ${index}` })));
  installFetcher();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  expect(screen.queryByText("历史消息 0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /加载更早的消息/ }));
  const old = screen.getByText("历史消息 20").closest("article")!;
  confirmDeletion(old);
  expect(screen.queryByText("历史消息 20")).toBeNull();
  expect(storedMessages()).toHaveLength(79);
  expect(storedMessages().map((message) => message.id)).toEqual(Array.from({ length: 80 }, (_, index) => `message-${index}`).filter((id) => id !== "message-20"));
  fireEvent.click(screen.getByRole("button", { name: /加载更早的消息/ }));
  expect(screen.getByText("历史消息 0")).toBeTruthy();
  expect(screen.getByText("历史消息 79")).toBeTruthy();
  await screen.findByText("chat-model");
});

it("keeps deletion after reopening and excludes it from the next model request", async () => {
  seed([
    { id: "u1", role: "user", content: "保留的提问" },
    { id: "a1", role: "assistant", content: "要删除的回答", replyTo: "u1" },
    { id: "u2", role: "user", content: "另一个提问" },
    { id: "a2", role: "assistant", content: "另一个回答", replyTo: "u2" },
  ]);
  const fetcher = installFetcher();
  const view = render(<MobileChat apiKey="first-key" onBack={() => {}} />);
  confirmDeletion(rows()[1]);
  await screen.findByText("chat-model");
  view.unmount();
  render(<MobileChat apiKey="second-key" onBack={() => {}} />);
  expect(screen.queryByText("要删除的回答")).toBeNull();
  expect(screen.getByText("保留的提问")).toBeTruthy();
  await send("接着讨论");
  await screen.findByText("新的回答");
  const request = fetcher.mock.calls.find(([url]) => !modelRequest(url))?.[1];
  expect(JSON.parse(request?.body as string).messages).toEqual([
    { role: "user", content: "保留的提问" },
    { role: "user", content: "另一个提问" },
    { role: "assistant", content: "另一个回答" },
    { role: "user", content: "接着讨论" },
  ]);
  expect(storedMessages().some((message) => message.id === "a1")).toBe(false);
});

it("does not resurrect deleted history in later stream deltas, checkpoints, or completion", async () => {
  seed([{ id: "old", role: "user", content: "删除这条历史" }, { id: "old-answer", role: "assistant", content: "保留历史回答", replyTo: "old" }]);
  const stream = controlledResponse();
  const fetcher = installFetcher(() => stream.response);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await send("正在执行的问题");
  await act(async () => { stream.push({ choices: [{ delta: { content: "第一段" } }] }); });
  await screen.findByText("第一段");
  confirmDeletion(screen.getByText("删除这条历史").closest("article")!);
  expect(storedMessages().some((message) => message.id === "old")).toBe(false);
  expect(fetcher.mock.calls.find(([url]) => !modelRequest(url))?.[1]?.signal?.aborted).toBe(false);
  await act(async () => { stream.push({ choices: [{ delta: { content: "第二段" } }] }); });
  await screen.findByText("第一段第二段");
  fireEvent(window, new Event("pagehide"));
  expect(storedMessages().some((message) => message.id === "old")).toBe(false);
  expect(screen.queryByText("删除这条历史")).toBeNull();
  await act(async () => { stream.push({ choices: [{ finish_reason: "stop" }] }); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "停止" })).toBeNull());
  expect(storedMessages().map((message) => message.content)).toEqual(["保留历史回答", "正在执行的问题", "第一段第二段"]);
});

it("aborts the request when deleting an active answer and prevents pending deltas or unmount from recreating it", async () => {
  const stream = controlledResponse();
  const fetcher = installFetcher(() => stream.response);
  const view = render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await send("保留我的问题");
  await act(async () => { stream.push({ choices: [{ delta: { content: "正在生成的答案" } }] }); });
  await screen.findByText("正在生成的答案");
  await act(async () => { stream.push({ choices: [{ delta: { content: "还没显示的增量" } }] }); });
  confirmDeletion(screen.getByText("正在生成的答案").closest("article")!);
  expect(fetcher.mock.calls.find(([url]) => !modelRequest(url))?.[1]?.signal?.aborted).toBe(true);
  await waitFor(() => expect(stream.cancel).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole("button", { name: "停止" })).toBeNull());
  fireEvent(window, new Event("pagehide"));
  expect(rows()).toHaveLength(1);
  expect(screen.getByText("保留我的问题")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重新回答" })).toBeNull();
  view.unmount();
  expect(storedMessages().map((message) => message.content)).toEqual(["保留我的问题"]);
});

it("does not retry an unrelated earlier question after its failed answer's question is deleted", async () => {
  seed([
    { id: "old-user", role: "user", content: "更早的问题" },
    { id: "current-user", role: "user", content: "失败回答对应的问题" },
    { id: "failed-answer", role: "assistant", content: "未完成的答案", status: "failed", replyTo: "current-user" },
  ]);
  const fetcher = installFetcher();
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByRole("button", { name: "重新回答" });
  confirmDeletion(screen.getByText("失败回答对应的问题").closest("article")!);
  expect(screen.queryByRole("button", { name: "重新回答" })).toBeNull();
  expect(screen.getByText("更早的问题")).toBeTruthy();
  expect(screen.getByText("未完成的答案")).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => !modelRequest(url))).toHaveLength(0);
});

it("does not reattach a failed stream to an older question when the active question is deleted", async () => {
  seed([{ id: "old-user", role: "user", content: "先前未回答的问题" }]);
  const stream = controlledResponse();
  installFetcher(() => stream.response);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await send("此次的问题");
  await act(async () => { stream.push({ choices: [{ delta: { content: "部分答案" } }] }); });
  await screen.findByText("部分答案");
  confirmDeletion(screen.getByText("此次的问题").closest("article")!);
  await act(async () => { stream.close(); });
  await screen.findByText(/连接在回答完成前中断/);
  expect(screen.queryByRole("button", { name: "重新回答" })).toBeNull();
  expect(storedMessages().map((message) => message.content)).toEqual(["先前未回答的问题", "部分答案"]);
});
