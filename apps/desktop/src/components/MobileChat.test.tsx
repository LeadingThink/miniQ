// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileChat } from "./MobileChat";
import { MOBILE_CHAT_STORAGE_KEY, MOBILE_MODEL_STORAGE_KEY } from "../mobileChatData";

vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <div>{children}</div> }));

const catalog = [
  { id: "custom-chat", model_type: "chat" },
  { id: "gemini-test", model_type: "chat" },
  { id: "image-model", model_type: "image" },
];
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const doneResponse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`);
const modelRequest = (url: unknown) => String(url).endsWith("/models");

function controlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }));
  return { response, cancel,
    push: (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)),
    close: () => controller.close(),
  };
}

async function enterQuestion(text = "原问题") {
  await waitFor(() => expect(screen.getByRole("button", { name: "问答模型" }).hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: "输入问题或任务" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("selects an available text model, supports search, and sends the selected model", async () => {
  localStorage.setItem(MOBILE_MODEL_STORAGE_KEY, "obsolete-model");
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url) ? json({ data: catalog }) : doneResponse("已完成")));
  vi.stubGlobal("fetch", fetcher);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("custom-chat");
  fireEvent.click(screen.getByRole("button", { name: "问答模型" }));
  expect(screen.queryByRole("option", { name: "image-model" })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索模型" }), { target: { value: "GEMINI" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.click(screen.getByRole("option", { name: "gemini-test" }));
  await enterQuestion();
  await screen.findByText("已完成");
  const request = fetcher.mock.calls.find(([url]) => !modelRequest(url));
  expect(JSON.parse((request?.[1] as RequestInit)?.body as string).model).toBe("gemini-test");
  expect(localStorage.getItem(MOBILE_MODEL_STORAGE_KEY)).toBe("gemini-test");
});

it("does not send an unavailable fallback model and reloads a failed catalog without losing input", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(json({ data: catalog }));
  vi.stubGlobal("fetch", fetcher);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "先写下问题" } });
  await screen.findByText("请求失败（503）");
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新加载模型" }));
  await screen.findByText("custom-chat");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("先写下问题");
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps a partial answer after network EOF and retries the same question without duplicating it", async () => {
  let request = 0;
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url) ? json({ data: catalog })
    : ++request === 1 ? new Response('data: {"choices":[{"delta":{"content":"部分答案"}}]}\n\n') : doneResponse("完整答案")));
  vi.stubGlobal("fetch", fetcher);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await enterQuestion();
  await screen.findByText(/连接在回答完成前中断/);
  expect(screen.getByText("部分答案")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新回答" }));
  await screen.findByText("完整答案");
  const requests = fetcher.mock.calls.filter(([url]) => !modelRequest(url)).map(([, init]) => JSON.parse(init?.body as string));
  expect(requests.map((body) => body.messages)).toEqual([
    [{ role: "user", content: "原问题" }], [{ role: "user", content: "原问题" }],
  ]);
  expect(screen.getAllByText("原问题")).toHaveLength(1);
});

it("does not send Enter while the Chinese input method is composing", async () => {
  const fetcher = vi.fn((url: unknown) => Promise.resolve(modelRequest(url) ? json({ data: catalog }) : doneResponse("回答")));
  vi.stubGlobal("fetch", fetcher);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("custom-chat");
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "中文候选词" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((input as HTMLTextAreaElement).value).toBe("中文候选词");
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("回答");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([{}, { ctrlKey: true }])("inserts a newline at the selection with Shift+Enter and sends the full draft with Enter: %j", async (sendModifier) => {
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url) ? json({ data: catalog }) : doneResponse("回答")));
  vi.stubGlobal("fetch", fetcher);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("custom-chat");
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  const hint = screen.getByText("Enter 发送，Shift＋Enter 换行");
  expect(input.getAttribute("aria-describedby")).toBe(hint.id);
  fireEvent.change(input, { target: { value: "第一行替换第二行" } });
  input.setSelectionRange(3, 5);
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(input.value).toBe("第一行\n第二行");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByText(hint.textContent!)).toBe(hint);
  await waitFor(() => {
    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(4);
  });
  fireEvent.keyDown(input, { key: "Enter", ...sendModifier });
  await screen.findByText("回答");
  const request = fetcher.mock.calls.find(([url]) => !modelRequest(url))?.[1];
  expect(JSON.parse(request?.body as string).messages).toEqual([{ role: "user", content: "第一行\n第二行" }]);
  expect(input.value).toBe("");
});

it.each([
  { shiftKey: true, isComposing: true },
  { shiftKey: true, keyCode: 229 },
  { ctrlKey: true, isComposing: true },
  { ctrlKey: true, keyCode: 229 },
])("does not insert or send modified Enter during IME composition: %j", async (composition) => {
  const fetcher = vi.fn((url: unknown) => Promise.resolve(modelRequest(url) ? json({ data: catalog }) : doneResponse("回答")));
  vi.stubGlobal("fetch", fetcher);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await screen.findByText("custom-chat");
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "中文候选词" } });
  input.setSelectionRange(2, 2);
  fireEvent.keyDown(input, { key: "Enter", ...composition });
  expect(input.value).toBe("中文候选词");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["failed", "interrupted"])("preserves the %s partial answer when the user asks to continue", async (status) => {
  const streaming = controlledResponse();
  let request = 0;
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url) ? json({ data: catalog })
    : ++request === 1 ? streaming.response : doneResponse("接着完成")));
  vi.stubGlobal("fetch", fetcher);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await enterQuestion("写一份长方案");
  await act(async () => { streaming.push({ choices: [{ delta: { content: "第一部分已写好" } }] }); });
  await screen.findByText("第一部分已写好");
  if (status === "failed") await act(async () => { streaming.close(); });
  else fireEvent.click(screen.getByRole("button", { name: "停止" }));
  await screen.findByRole("button", { name: "重新回答" });
  await enterQuestion("继续");
  await screen.findByText("接着完成");
  const last = fetcher.mock.calls.filter(([url]) => !modelRequest(url)).at(-1)?.[1];
  expect(JSON.parse(last?.body as string).messages).toEqual([
    { role: "user", content: "写一份长方案" },
    { role: "assistant", content: "第一部分已写好" },
    { role: "user", content: "继续" },
  ]);
});

it("does not steal the user's scroll or rewrite history for every streaming chunk", async () => {
  const streaming = controlledResponse();
  vi.stubGlobal("fetch", vi.fn((url: unknown) => Promise.resolve(modelRequest(url) ? json({ data: catalog }) : streaming.response)));
  const writes = vi.spyOn(Storage.prototype, "setItem");
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  const feed = screen.getByRole("region", { name: "问答记录" });
  Object.defineProperties(feed, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 300 } });
  await enterQuestion();
  feed.scrollTop = 100;
  fireEvent.scroll(feed);
  await act(async () => { streaming.push({ choices: [{ delta: { content: "流式内容" } }] }); });
  await screen.findByText("流式内容");
  expect(feed.scrollTop).toBe(100);
  expect(writes.mock.calls.filter(([key]) => key === MOBILE_CHAT_STORAGE_KEY)).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "查看最新内容" }));
  expect(feed.scrollTop).toBe(1000);
  await act(async () => { streaming.push({ choices: [{ finish_reason: "stop" }] }); });
  await waitFor(() => expect(writes.mock.calls.filter(([key]) => key === MOBILE_CHAT_STORAGE_KEY)).toHaveLength(1));
});

it("aborts the request when leaving chat and saves the partial answer for the next key", async () => {
  const streaming = controlledResponse();
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url) ? json({ data: catalog }) : streaming.response));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<MobileChat apiKey="first-key" onBack={() => {}} />);
  await enterQuestion();
  await act(async () => { streaming.push({ choices: [{ delta: { content: "已收到的内容" } }] }); });
  await screen.findByText("已收到的内容");
  const init = fetcher.mock.calls.find(([url]) => !modelRequest(url))?.[1];
  view.unmount();
  expect(init?.signal?.aborted).toBe(true);
  await waitFor(() => expect(streaming.cancel).toHaveBeenCalledOnce());
  render(<MobileChat apiKey="second-key" onBack={() => {}} />);
  expect(screen.getByText("已收到的内容")).toBeTruthy();
  expect(screen.getByText("已停止，收到的内容已保留")).toBeTruthy();
});

it.each(["pagehide", "visibilitychange"])("checkpoints on %s without stopping or altering the live answer", async (eventName) => {
  const streaming = controlledResponse();
  const fetcher = vi.fn((url: unknown, _init?: RequestInit) => Promise.resolve(modelRequest(url) ? json({ data: catalog }) : streaming.response));
  vi.stubGlobal("fetch", fetcher);
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  await enterQuestion();
  await act(async () => { streaming.push({ choices: [{ delta: { content: "切后台前" } }] }); });
  if (eventName === "visibilitychange") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event(eventName));
  } else {
    fireEvent(window, new Event(eventName));
  }
  expect(JSON.parse(localStorage.getItem(MOBILE_CHAT_STORAGE_KEY) ?? "[]").at(-1))
    .toEqual({ role: "assistant", content: "切后台前", status: "interrupted" });
  expect(fetcher.mock.calls.find(([url]) => !modelRequest(url))?.[1]?.signal?.aborted).toBe(false);
  expect(streaming.cancel).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
  expect(screen.queryByText("已停止，收到的内容已保留")).toBeNull();
  await act(async () => { streaming.push({ choices: [{ delta: { content: "，回来后继续" }, finish_reason: "stop" }] }); });
  await screen.findByText("切后台前，回来后继续");
  expect(JSON.parse(localStorage.getItem(MOBILE_CHAT_STORAGE_KEY) ?? "[]").at(-1))
    .toEqual({ role: "assistant", content: "切后台前，回来后继续" });
});

it("loads older history on demand without dropping any messages from storage", async () => {
  const history = Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `消息 ${index}` }));
  localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, JSON.stringify(history));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: catalog })));
  render(<MobileChat apiKey="test-key" onBack={() => {}} />);
  expect(screen.queryByText("消息 0")).toBeNull();
  expect(screen.getByText("消息 79")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /加载更早的消息/ }));
  fireEvent.click(screen.getByRole("button", { name: /加载更早的消息/ }));
  expect(screen.getByText("消息 0")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(MOBILE_CHAT_STORAGE_KEY) ?? "[]")).toHaveLength(80);
  await screen.findByText("custom-chat");
});
