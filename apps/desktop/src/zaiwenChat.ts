import { fetchZaiwen, readZaiwenResponse, requestZaiwen, ZaiwenApiError } from "./zaiwenApi";
import type { ZaiwenSession } from "./zaiwenAuth";
import { isZaiwenMessage, type ZaiwenMessage } from "./zaiwenHistory";

export interface ZaiwenChatModel { key: string; label?: string }
export interface ZaiwenChatEvent {
  type: string;
  conversation_id?: string;
  request_id?: string;
  content?: string;
  data?: unknown;
}

export async function listZaiwenChatModels(session: ZaiwenSession, signal: AbortSignal): Promise<ZaiwenChatModel[]> {
  const response = await requestZaiwen<unknown>("config/model/chat/", { method: "GET", signal }, session.token);
  if (!Array.isArray(response.data) || !response.data.length || !response.data.every((item) =>
    item && typeof item.key === "string" && item.key && (item.label === undefined || typeof item.label === "string"))) {
    throw new Error("在问模型列表无效，请重试");
  }
  return response.data;
}

export function zaiwenEventMessage(value: unknown): ZaiwenMessage {
  if (!isZaiwenMessage(value) || !["user", "assistant"].includes(value.role)) {
    throw new Error("在问消息格式无效");
  }
  return value;
}

/** Zaiwen emits typed SSE events, not OpenAI completion deltas. */
export async function streamZaiwenMessage(session: ZaiwenSession, conversationId: string, content: string, model: string,
  signal: AbortSignal, onEvent: (event: ZaiwenChatEvent) => void, onRequest: (id: string) => void): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = () => { timedOut = true; controller.abort(); };
  const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(timeout, ms); };
  const total = setTimeout(timeout, 30 * 60_000);
  arm(45_000);
  try {
    const response = await fetchZaiwen("ai/message/stream", {
      method: "POST", signal: controller.signal,
      body: JSON.stringify({ conversation_id: conversationId, data: {
        content, model, type: "text", round: 5, online: false, agent: false, file_context: "inherit",
      } }),
    }, session.token);
    if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await readZaiwenResponse(response);
      throw new Error("在问未返回聊天响应，请刷新会话后重试");
    }
    if (!response.body) throw new Error("当前平台不支持流式回复");
    const requestId = response.headers.get("X-AI-Request-ID");
    if (requestId) onRequest(requestId);
    arm(120_000);
    await readZaiwenStream(response.body, controller.signal, (event) => {
      if (event.conversation_id && event.conversation_id !== conversationId) throw new Error("在问响应的会话不匹配");
      if (event.request_id) onRequest(event.request_id);
      onEvent(event);
    }, () => arm(120_000));
  } catch (cause) {
    if (timedOut && !signal.aborted) throw new Error("回复超时，已保留收到的内容，请刷新会话确认结果");
    throw cause;
  } finally {
    clearTimeout(timer!); clearTimeout(total);
    signal.removeEventListener("abort", abort);
  }
}

export async function readZaiwenStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal,
  onEvent: (event: ZaiwenChatEvent) => void, onActivity?: () => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "", data: string[] = [], complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const consume = () => {
    const text = data.join("\n");
    data = [];
    if (!text) return;
    if (text.trim() === "[DONE]") { complete = true; return; }
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object") throw new Error("在问流式响应格式无效");
    if (value.code !== undefined && String(value.code) !== "0")
      throw new ZaiwenApiError(String(value.msg || "在问请求未受理"), 200, String(value.code));
    if (value.type === "error" || (value.type === "notice" && value.event === "insufficient_balance"))
      throw new Error(String(value.message || value.msg || value.data || "在问回复失败，请重试"));
    if (typeof value.type !== "string") throw new Error("在问流式响应格式无效");
    const progress = value.type === "progress" && value.data && typeof value.data === "object"
      ? value.data as Record<string, unknown> : null;
    if (progress && ["failed", "interrupted"].includes(String(progress.status)))
      throw new Error(String(progress.message || progress.label || "在问回复未完成，请刷新会话确认结果"));
    onEvent(value as unknown as ZaiwenChatEvent);
    // The main site's stream closes after its terminal progress snapshot, without [DONE].
    if (progress && ["completed", "cancelled"].includes(String(progress.status))) complete = true;
  };
  const line = (text: string) => {
    if (!text) consume();
    else if (text.startsWith("data:")) data.push(text.slice(5).replace(/^ /, ""));
    // Some business rejections are returned as JSON even with an SSE content type.
    else if (text.startsWith("{")) { data.push(text); consume(); }
  };
  try {
    while (!complete) {
      if (signal.aborted) throw new DOMException("已停止接收回复", "AbortError");
      const { value, done } = await reader.read();
      if (value?.length) onActivity?.();
      if (signal.aborted) throw new DOMException("已停止接收回复", "AbortError");
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while (!complete && (match = /\r\n|\n|\r/.exec(buffer))) {
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) break;
        const text = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        line(text);
      }
      if (done) { if (buffer) line(buffer); consume(); break; }
    }
    if (!complete) throw new Error("回复连接中断，已保留收到的内容，请刷新会话确认结果");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function cancelZaiwenMessage(session: ZaiwenSession, conversationId: string, requestId: string): Promise<void> {
  const response = await requestZaiwen<{ request_id: string; status: string }>("ai/message/stream/cancel", {
    method: "POST", body: JSON.stringify({ request_id: requestId, conversation_id: conversationId }),
  }, session.token);
  if (response.data?.request_id !== requestId || !["cancel_requested", "cancelled", "completed", "failed", "interrupted"].includes(response.data.status))
    throw new Error("在问取消响应无效，请重试");
}
