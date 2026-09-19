import { describe, expect, it } from "vitest";
import { readSse } from "../mobileChatStream";

describe("readSse", () => {
  it("preserves split chunks and consumes a final line without a newline", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}'));
        controller.close();
      },
    });
    let content = "";

    await readSse(stream, (delta) => { content += delta; });

    expect(content).toBe("你好");
  });
});
