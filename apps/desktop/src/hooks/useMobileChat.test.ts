// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MOBILE_CHAT_STORAGE_KEY, readMobileChat } from "../mobileChatData";
import { useMobileChat } from "./useMobileChat";

let tick = 100;
const start = "2026-09-20T08:00:00.000Z";

function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  return { response,
    push: (content: string, done = false) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
      choices: [{ delta: { content }, ...(done ? { finish_reason: "stop" } : {}) }],
    })}\n\n`)),
    close: () => controller.close(),
  };
}

beforeEach(() => {
  localStorage.clear();
  tick = 100;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  vi.spyOn(performance, "now").mockImplementation(() => tick);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("records dates and monotonic time while sending model first without timing metadata", async () => {
  const stream = streamResponse();
  const fetcher = vi.fn().mockResolvedValue(stream.response);
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useMobileChat("test-key", "test-model"));
  act(() => { result.current.send("问题"); });
  expect(result.current.messages.map((message) => message.createdAt)).toEqual([start, start]);
  // A system clock correction must not turn the runtime into a negative duration.
  tick += 72_000;
  vi.setSystemTime("2026-09-20T07:59:00.000Z");
  await act(async () => { stream.push("答案", true); });
  await waitFor(() => expect(result.current.busy).toBe(false));
  const answer = result.current.messages[1];
  expect(answer).toMatchObject({ createdAt: start, completedAt: "2026-09-20T07:59:00.000Z", elapsedMs: 72_000 });
  expect(readMobileChat()[1]).toEqual(answer);
  const requestBody = fetcher.mock.calls[0][1].body;
  expect(requestBody.startsWith('{"model":"test-model",')).toBe(true);
  expect(JSON.parse(requestBody)).toEqual({
    model: "test-model", messages: [{ role: "user", content: "问题" }], stream: true,
  });
});

it("freezes failed timing and gives retries their own start while preserving the question's date", async () => {
  const first = streamResponse();
  const second = streamResponse();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response));
  const { result } = renderHook(() => useMobileChat("test-key", "test-model"));
  act(() => { result.current.send("问题"); });
  tick += 2300;
  await act(async () => { first.push("未完成"); first.close(); });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.messages[1]).toMatchObject({ elapsedMs: 2300, status: "failed" });
  tick += 90_000;
  vi.setSystemTime("2026-09-20T08:03:00.000Z");
  act(() => { expect(result.current.retry()).toBe(true); });
  expect(result.current.messages[0].createdAt).toBe(start);
  expect(result.current.messages[1]).toMatchObject({ createdAt: "2026-09-20T08:03:00.000Z" });
  expect(result.current.messages[1]).not.toHaveProperty("elapsedMs");
  tick += 5200;
  await act(async () => { second.push("重试完成", true); });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.messages[1].elapsedMs).toBe(5200);
  expect(result.current.messages[1]).not.toHaveProperty("status");
});

it("freezes timing at the stop action instead of waiting for abort cleanup", async () => {
  const stream = streamResponse();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
  const { result } = renderHook(() => useMobileChat("test-key", "test-model"));
  act(() => { result.current.send("问题"); });
  await act(async () => { stream.push("部分内容"); });
  tick += 4100;
  act(() => { result.current.stop(); });
  tick += 9000;
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.messages[1]).toMatchObject({ elapsedMs: 4100, status: "interrupted" });
  expect(readMobileChat()[1].elapsedMs).toBe(4100);
});

it("checkpoints recoverable timing without freezing a request that continues in the foreground", async () => {
  const stream = streamResponse();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
  const { result } = renderHook(() => useMobileChat("test-key", "test-model"));
  act(() => { result.current.send("问题"); });
  await act(async () => { stream.push("前半段"); });
  tick += 3000;
  act(() => { window.dispatchEvent(new Event("pagehide")); });
  expect(readMobileChat()[1]).toMatchObject({ elapsedMs: 3000, status: "interrupted" });
  expect(result.current.messages[1]).not.toHaveProperty("completedAt");
  tick += 4000;
  await act(async () => { stream.push("后半段", true); });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(readMobileChat()[1]).toMatchObject({ content: "前半段后半段", elapsedMs: 7000 });
  expect(readMobileChat()[1]).not.toHaveProperty("status");
});

it("saves timing when leaving and never invents dates for older stored history", async () => {
  localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, JSON.stringify([{ role: "user", content: "旧问题" }]));
  const stream = streamResponse();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
  const { result, unmount } = renderHook(() => useMobileChat("test-key", "test-model"));
  expect(result.current.messages[0]).not.toHaveProperty("createdAt");
  act(() => { result.current.send("新问题"); });
  await act(async () => { stream.push("新答案"); });
  tick += 8000;
  unmount();
  expect(readMobileChat()[0]).not.toHaveProperty("createdAt");
  expect(readMobileChat()[2]).toMatchObject({ content: "新答案", elapsedMs: 8000, status: "interrupted" });
});
