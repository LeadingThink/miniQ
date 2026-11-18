import { afterEach, expect, it, vi } from "vitest";
import { cancelZaiwenMessage, readZaiwenStream, streamZaiwenMessage, listZaiwenChatModels } from "./zaiwenChat";
import { ZaiwenApiError } from "./zaiwenApi";

const session = { token: "test-token", user: { uid: "test-user" } };
function bytes(text: string, size = 1) {
  const value = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < value.length; offset += size) controller.enqueue(value.slice(offset, offset + size));
    controller.close();
  } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("continues the exact cloud conversation using the main site's authenticated stream contract", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes('data: {"type":"streaming","conversation_id":"cloud","content":"你好"}\n\ndata: [DONE]\n\n'), {
    headers: { "content-type": "text/event-stream", "X-AI-Request-ID": "request" },
  })));
  const event = vi.fn(), request = vi.fn();
  await streamZaiwenMessage(session, "cloud", "继续", "model", new AbortController().signal, event, request);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe("https://back.zaiwenai.com/api/v1/ai/message/stream");
  expect(new Headers(init?.headers).get("token")).toBe(session.token);
  expect(new Headers(init?.headers).get("channel")).toBe("web.zaiwenai.com");
  expect(JSON.parse(String(init?.body))).toEqual({ conversation_id: "cloud", data: {
    content: "继续", model: "model", type: "text", round: 5, online: false, agent: false, file_context: "inherit",
  } });
  expect(request).toHaveBeenCalledWith("request");
  expect(event).toHaveBeenCalledWith({ type: "streaming", conversation_id: "cloud", content: "你好" });
});

it("decodes UTF-8, CRLF, heartbeats and multi-line events split across arbitrary chunks", async () => {
  const event = vi.fn();
  await readZaiwenStream(bytes(': ping\r\nevent: message\r\ndata: {"type":"streaming",\r\ndata: "content":"你好🌍"}\r\n\r\ndata: [DONE]\r\n\r\n'), new AbortController().signal, event);
  expect(event).toHaveBeenCalledExactlyOnceWith({ type: "streaming", content: "你好🌍" });
});

it.each(["completed", "cancelled"])("accepts the main site's terminal %s progress without a DONE marker", async (status) => {
  const events = [
    { type: "progress", data: { status: "running", stage: "generating" } },
    { type: "streaming", content: "你好" },
    { type: "assistant-message", data: { id: "answer", role: "assistant", content: "你好。", created: 1700000000 } },
    { type: "conversation", data: { id: "cloud", title: "问候" } },
    { type: "progress", data: { status, stage: status, can_cancel: false } },
  ].map((event) => ({ ...event, conversation_id: "cloud", request_id: "request" }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")), {
    headers: { "content-type": "text/event-stream" },
  })));
  const event = vi.fn(), request = vi.fn();
  await streamZaiwenMessage(session, "cloud", "你好", "model", new AbortController().signal, event, request);
  expect(event.mock.calls.map(([value]) => value)).toEqual(events);
  expect(request).toHaveBeenCalledWith("request");
  expect(fetch).toHaveBeenCalledOnce();
});

it("releases the connection once terminal progress arrives even if the server keeps it open", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"progress","data":{"status":"completed"}}\n\n'));
    },
    cancel,
  });
  await readZaiwenStream(stream, new AbortController().signal, vi.fn());
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
});

it.each(["failed", "interrupted"])("reports %s progress even after receiving a final message", async (status) => {
  const event = vi.fn();
  const answer = { type: "assistant-message", data: { id: "answer", role: "assistant", content: "已生成内容", created: 1700000000 } };
  const failure = { type: "progress", data: { status, label: "保存回复失败" } };
  await expect(readZaiwenStream(bytes(`data: ${JSON.stringify(answer)}\n\ndata: ${JSON.stringify(failure)}\n\ndata: [DONE]\n\n`),
    new AbortController().signal, event)).rejects.toThrow("保存回复失败");
  expect(event).toHaveBeenCalledExactlyOnceWith(answer);
});

it("does not treat a final message as confirmed completion while the server is still saving", async () => {
  const events = [
    { type: "assistant-message", data: { id: "answer", role: "assistant", content: "已生成内容", created: 1700000000 } },
    { type: "progress", data: { status: "running", stage: "saving" } },
  ];
  const event = vi.fn();
  await expect(readZaiwenStream(bytes(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")),
    new AbortController().signal, event)).rejects.toThrow("回复连接中断");
  expect(event.mock.calls.map(([value]) => value)).toEqual(events);
});

it.each([
  ['data: {"code":"02401","msg":"登录已过期"}', "登录已过期"],
  ['{"code":"02402","msg":"额度不足"}', "额度不足"],
  ['data: {"type":"error","data":"服务不可用"}\n\n', "服务不可用"],
  ['data: {"type":"notice","event":"insufficient_balance","message":"点数不足"}\n\n', "点数不足"],
  ['data: {"type":"streaming","content":"部分内容"}\n\n', "回复连接中断"],
])("reports errors or premature EOF without resending: %s", async (input, message) => {
  await expect(readZaiwenStream(bytes(input), new AbortController().signal, vi.fn())).rejects.toThrow(message);
});

it("rejects a response for a different conversation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes('data: {"type":"streaming","conversation_id":"other","content":"private"}\n\ndata: [DONE]\n\n'), { headers: { "content-type": "text/event-stream" } })));
  const event = vi.fn();
  await expect(streamZaiwenMessage(session, "cloud", "继续", "model", new AbortController().signal, event, vi.fn())).rejects.toThrow("会话不匹配");
  expect(event).not.toHaveBeenCalled();
});

it("recognizes login errors before consuming a stream", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "02401", msg: "expired" }), { status: 401 })));
  await expect(streamZaiwenMessage(session, "cloud", "继续", "model", new AbortController().signal, vi.fn(), vi.fn())).rejects.toMatchObject({ requiresLogin: true });
});

it("cancels a blocked reader when leaving the conversation", async () => {
  const request = new AbortController(), cancel = vi.fn();
  const promise = readZaiwenStream(new ReadableStream({ cancel }), request.signal, vi.fn());
  request.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledOnce();
});

it("loads authenticated chat models and rejects an empty catalog", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: [{ key: "model", label: "模型" }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: [] }))));
  await expect(listZaiwenChatModels(session, new AbortController().signal)).resolves.toEqual([{ key: "model", label: "模型" }]);
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://back.zaiwenai.com/api/v1/config/model/chat/");
  await expect(listZaiwenChatModels(session, new AbortController().signal)).rejects.toThrow("模型列表无效");
});

it("uses the server cancel API with an exact request and conversation id", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { request_id: "request", status: "cancel_requested" } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "02401", msg: "expired" }), { status: 401 })));
  await cancelZaiwenMessage(session, "cloud", "request");
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ request_id: "request", conversation_id: "cloud" });
  await expect(cancelZaiwenMessage(session, "cloud", "request")).rejects.toBeInstanceOf(ZaiwenApiError);
});

it("bounds a stalled connection without automatically retrying a POST", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_input, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
  })));
  const promise = streamZaiwenMessage(session, "cloud", "继续", "model", new AbortController().signal, vi.fn(), vi.fn());
  const assertion = expect(promise).rejects.toThrow("回复超时");
  await vi.advanceTimersByTimeAsync(45_001);
  await assertion;
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
