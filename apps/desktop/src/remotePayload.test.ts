import { expect, it } from "vitest";
import { RemotePayloadReader } from "./remotePayload";
import { gzipSync } from "node:zlib";

function chunks(payload: unknown, size: number) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => ({
    type: "remote_chunk",
    transferId: "transfer-1",
    index,
    totalBytes: bytes.length,
    data: bytes
      .subarray(index * size, (index + 1) * size)
      .toString("base64url"),
  }));
}

it("reassembles a large session without losing Unicode, tools or output", () => {
  const payload = {
    id: "request-1",
    result: { tools: [{ output: "任务结果".repeat(400_000) }] },
  };
  const reader = new RemotePayloadReader();
  const frames = chunks(payload, 768 * 1024);
  const output = frames.flatMap((frame) => reader.read(frame));
  expect(frames.length).toBeGreaterThan(4);
  expect(output).toEqual([payload]);
});

it("preserves all events and their ordering within an encrypted batch", () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({
    type: "assistant_delta",
    sessionId: i % 2 ? "a" : "b",
    delta: String(i),
  }));
  const reader = new RemotePayloadReader();
  expect(
    chunks({ type: "remote_batch", items }, 97).flatMap((frame) =>
      reader.read(frame)
    )
  ).toEqual(items);
});

it("rejects missing, repeated and out-of-order chunks", () => {
  const frames = chunks({ result: "abc".repeat(100) }, 20);
  expect(() => new RemotePayloadReader().read(frames[1])).toThrow("起始块");
  const reader = new RemotePayloadReader();
  reader.read(frames[0]);
  expect(() => reader.read(frames[0])).toThrow("顺序");
});

it("does not retain incomplete data across reconnects", () => {
  const frames = chunks({ result: "a long answer" }, 5);
  const reader = new RemotePayloadReader();
  expect(reader.read(frames[0])).toEqual([]);
  const reconnected = new RemotePayloadReader();
  expect(reconnected.read({ id: "new", result: "new answer" })).toEqual([
    { id: "new", result: "new answer" },
  ]);
  expect(() => reconnected.read(frames[1])).toThrow("起始块");
});

it("reassembles interleaved transfers without dropping either response", () => {
  const a = {id:"a", result:"A".repeat(100)};
  const b = {id:"b", result:"B".repeat(100)};
  const one = chunks(a, 10);
  const two = chunks(b, 10).map((frame) => ({...frame, transferId:"transfer-2"}));
  const reader = new RemotePayloadReader();
  const results = one.flatMap((frame, index) => [...reader.read(frame), ...reader.read(two[index])]);
  expect(results).toEqual([a, b]);
});

it("discards a cancelled transfer but keeps another request usable", () => {
  const frames = chunks({id:"old", result:"old output".repeat(100)}, 20).map((frame) => ({...frame, requestId:"old"}));
  const reader = new RemotePayloadReader();
  reader.read(frames[0]);
  reader.cancelRequest("old");
  expect(frames.slice(1).flatMap((frame) => reader.read(frame))).toEqual([]);
  expect(reader.read({id:"new", result:true})).toEqual([{id:"new", result:true}]);
});

it("decodes gzip after chunk assembly and checks the declared size", async () => {
  const payload = {id:"gzip", result:"压缩数据".repeat(10000)};
  const bytes = Buffer.from(JSON.stringify(payload));
  const compressed = {type:"remote_compressed", encoding:"gzip", uncompressedBytes:bytes.length, data:gzipSync(bytes).toString("base64url")};
  const reader = new RemotePayloadReader();
  const results = [];
  for (const frame of chunks(compressed, 40)) results.push(...await reader.readAsync(frame));
  expect(results).toEqual([payload]);
  await expect(reader.readAsync({...compressed, uncompressedBytes:20})).rejects.toThrow("声明长度");
  await expect(reader.readAsync({...compressed, uncompressedBytes:bytes.length + 1})).rejects.toThrow("不完整");
});
