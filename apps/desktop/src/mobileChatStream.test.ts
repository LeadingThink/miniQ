import { describe, expect, it, vi } from "vitest";
import { readSse } from "./mobileChatStream";

function streamOf(...chunks: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } });
}

describe("mobile chat stream", () => {
  it("preserves Unicode and event lines at every byte boundary, including split CRLF", async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"中文🙂"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    let content = "";
    await readSse(stream, (delta) => { content += delta; });
    expect(content).toBe("中文🙂");
    expect(stream.locked).toBe(false);
  });

  it.each(["[DONE]", '{"choices":[{"finish_reason":"stop"}]}'])
    ("finishes and cancels the body on %s without waiting for an idle connection", async (ending) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${ending}\n\n`)); }, cancel,
      });
      await readSse(stream, () => {});
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    });

  it("reports premature EOF while keeping all received text", async () => {
    const delta = vi.fn();
    await expect(readSse(streamOf('data: {"choices":[{"delta":{"content":"已收到"}}]}\n\n'), delta)).rejects.toThrow("回答完成前中断");
    expect(delta).toHaveBeenCalledWith("已收到");
  });

  it.each([
    ['event: error\ndata: {"message":"server overloaded"}\n\n', "server overloaded"],
    ['data: {"error":{"message":"upstream failed"}}\n\n', "upstream failed"],
    ['data: {"error":"provider failed"}\n\n', "provider failed"],
    ['data: incomplete\n\n', "格式无效"],
    ['data: {"choices":[{"finish_reason":"length"}]}\n\n', "输出达到上限"],
    ['data: {"choices":[{"finish_reason":"content_filter"}]}\n\n', "内容被服务方过滤"],
  ])("surfaces streaming errors instead of treating them as successful answers", async (data, message) => {
    await expect(readSse(streamOf(data), () => {})).rejects.toThrow(message);
  });

  it("stops and releases an idle reader when aborted", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const promise = readSse(stream, () => {}, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
