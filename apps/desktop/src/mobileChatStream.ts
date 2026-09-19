interface ChatStreamEvent {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  error?: { message?: string } | string;
  message?: string;
}

/** Parse SSE events, including CRLF and UTF-8 boundaries split across network chunks. */
export async function readSse(
  stream: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventData: string[] = [];
  let eventType = "";
  let completed = false;
  const abortError = () => signal?.reason ?? new DOMException("请求已停止", "AbortError");
  const abort = () => { void reader.cancel(abortError()).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });

  const consumeEvent = () => {
    const data = eventData.join("\n");
    const type = eventType;
    eventData = [];
    eventType = "";
    if (!data) return;
    if (data.trim() === "[DONE]") { completed = true; return; }
    let parsed: ChatStreamEvent;
    try { parsed = JSON.parse(data) as ChatStreamEvent; }
    catch { throw new Error("模型流式响应格式无效，请重试"); }
    if (!parsed || typeof parsed !== "object") throw new Error("模型流式响应格式无效，请重试");
    if (parsed.error || type === "error") {
      throw new Error(typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? "模型流式响应失败");
    }
    const choice = parsed.choices?.[0];
    if (typeof choice?.delta?.content === "string") onDelta(choice.delta.content);
    if (choice?.finish_reason === "length") throw new Error("模型输出达到上限，已保留收到的内容；可以发送消息要求继续");
    if (choice?.finish_reason === "content_filter") throw new Error("模型未能完成回答：内容被服务方过滤");
    if (choice?.finish_reason) completed = true;
  };

  const consumeLine = (line: string) => {
    if (!line) { consumeEvent(); return; }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") eventData.push(value);
    else if (field === "event") eventType = value;
  };

  const drainLines = (end: boolean) => {
    while (!completed) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const index = match.index;
      if (!end && buffer[index] === "\r" && index === buffer.length - 1) break;
      const length = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + length);
      consumeLine(line);
    }
    if (end && !completed) {
      if (buffer) consumeLine(buffer);
      buffer = "";
      consumeEvent();
    }
  };

  try {
    while (!completed) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError();
      buffer += decoder.decode(value, { stream: !done });
      drainLines(done);
      if (done) break;
    }
    if (!completed) throw new Error("连接在回答完成前中断，已保留收到的内容，请重试");
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
