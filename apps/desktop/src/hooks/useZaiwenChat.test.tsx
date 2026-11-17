// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useZaiwenChat } from "./useZaiwenChat";
import type { ZaiwenHistory } from "./useZaiwenHistory";
import { cancelZaiwenMessage, listZaiwenChatModels, readZaiwenStream, streamZaiwenMessage, type ZaiwenChatEvent } from "../zaiwenChat";
import { ZaiwenApiError } from "../zaiwenApi";

vi.mock("../zaiwenChat", async (original) => ({ ...await original<typeof import("../zaiwenChat")>(),
  cancelZaiwenMessage: vi.fn(), listZaiwenChatModels: vi.fn(), streamZaiwenMessage: vi.fn(),
}));
const session = { token: "token", user: { uid: "owner" } };
const user = { id: "server-user", role: "user", content: "继续", created: 1700000001 };
const assistant = { id: "server-assistant", role: "assistant", content: "完整回复", created: 1700000002, model: "model" };
let event: (value: ZaiwenChatEvent) => void;
let finish: () => void;
let fail: (cause: Error) => void;
let requestId: (id: string) => void;
const refresh = vi.fn();
function history(): ZaiwenHistory {
  return { selected: { id: "cloud", title: "主站会话", created: 1 }, conversations: { refresh },
    messages: { items: [{ id: "previous", role: "assistant", content: "原记录", created: 1700000000, model: "model" }], loading: false, error: "" },
  } as unknown as ZaiwenHistory;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listZaiwenChatModels).mockResolvedValue([{ key: "model", label: "模型" }]);
  vi.mocked(cancelZaiwenMessage).mockResolvedValue(undefined);
  vi.mocked(streamZaiwenMessage).mockImplementation((_session, _id, _content, _model, _signal, onEvent, onRequest) => {
    event = onEvent; requestId = onRequest;
    return new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  });
});
afterEach(cleanup);

it("continues a cloud session, merges confirmed messages without duplicates and never sends twice while busy", async () => {
  const { result, rerender } = renderHook(({ data }) => useZaiwenChat(session, data), { initialProps: { data: history() } });
  await waitFor(() => expect(result.current.model).toBe("model"));
  let accepted!: Promise<boolean>;
  act(() => { accepted = result.current.send("继续"); });
  expect(result.current.busy).toBe(true);
  await expect(result.current.send("重复发送")).resolves.toBe(false);
  expect(streamZaiwenMessage).toHaveBeenCalledExactlyOnceWith(session, "cloud", "继续", "model", expect.any(AbortSignal), expect.any(Function), expect.any(Function));
  act(() => { event({ type: "user-message", data: user }); event({ type: "streaming", content: "部分" }); });
  await expect(accepted).resolves.toBe(true);
  expect(result.current.messages.map((item) => item.content)).toEqual(["原记录", "继续", "部分"]);
  act(() => { event({ type: "assistant-message", data: assistant }); finish(); });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(refresh).toHaveBeenCalledOnce();
  const data = history();
  data.messages.items.push(user, assistant);
  rerender({ data });
  expect(result.current.messages.map((item) => item.id)).toEqual(["previous", user.id, assistant.id]);
  rerender({ data: { ...data, messages: { ...data.messages, items: data.messages.items.map((item) =>
    item.id === assistant.id ? { ...item, content: "主站修改后的回复" } : item) } } });
  expect(result.current.messages.at(-1)?.content).toBe("主站修改后的回复");
});

it("returns false on a rejected submission so the shared composer retains its draft", async () => {
  const { result } = renderHook(() => useZaiwenChat(session, history()));
  await waitFor(() => expect(result.current.model).toBe("model"));
  let accepted!: Promise<boolean>;
  act(() => { accepted = result.current.send("继续"); });
  await act(async () => fail(new ZaiwenApiError("额度不足", 402)));
  await expect(accepted).resolves.toBe(false);
  expect(result.current.error).toBe("额度不足");
  expect(result.current.messages.map((item) => item.content)).toEqual(["原记录"]);
  expect(result.current.busy).toBe(false);
});

it("finishes a real main-site progress stream without displaying a disconnect notice", async () => {
  const events = [
    { type: "user-message", data: user },
    { type: "streaming", content: "部分" },
    { type: "assistant-message", data: assistant },
    { type: "progress", data: { status: "completed", stage: "completed" } },
  ];
  vi.mocked(streamZaiwenMessage).mockImplementation(async (_session, _id, _content, _model, signal, onEvent) => {
    await readZaiwenStream(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")));
      controller.close();
    } }), signal, onEvent);
  });
  const { result } = renderHook(() => useZaiwenChat(session, history()));
  await waitFor(() => expect(result.current.model).toBe("model"));
  await act(async () => { await expect(result.current.send("继续")).resolves.toBe(true); });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.error).toBe("");
  expect(result.current.messages.map((item) => item.id)).toEqual(["previous", user.id, assistant.id]);
  expect(result.current.messages.at(-1)?.content).toBe("完整回复");
  expect(refresh).toHaveBeenCalledOnce();
  expect(streamZaiwenMessage).toHaveBeenCalledOnce();
});

it("keeps accepted partial replies on disconnect without automatically reposting the question", async () => {
  const { result } = renderHook(() => useZaiwenChat(session, history()));
  await waitFor(() => expect(result.current.model).toBe("model"));
  act(() => { void result.current.send("继续"); event({ type: "user-message", data: user }); event({ type: "streaming", content: "部分回复" }); });
  await act(async () => fail(new Error("连接已断开")));
  expect(result.current.error).toBe("连接已断开");
  expect(result.current.messages.map((item) => item.content)).toEqual(["原记录", "继续", "部分回复"]);
  expect(streamZaiwenMessage).toHaveBeenCalledOnce();
});

it("marks login expiry and blocks further sends", async () => {
  const { result } = renderHook(() => useZaiwenChat(session, history()));
  await waitFor(() => expect(result.current.model).toBe("model"));
  act(() => { void result.current.send("继续"); });
  await act(async () => fail(new ZaiwenApiError("expired", 401)));
  expect(result.current.requiresLogin).toBe(true);
  await expect(result.current.send("再试")).resolves.toBe(false);
  expect(streamZaiwenMessage).toHaveBeenCalledOnce();
});

it("requests server cancellation and keeps receiving its persisted final response", async () => {
  const { result } = renderHook(() => useZaiwenChat(session, history()));
  await waitFor(() => expect(result.current.model).toBe("model"));
  act(() => { void result.current.send("继续"); requestId("request"); });
  await act(async () => result.current.stop());
  expect(cancelZaiwenMessage).toHaveBeenCalledExactlyOnceWith(session, "cloud", "request");
  expect(result.current.busy).toBe(true);
  expect(result.current.stopping).toBe(true);
  act(() => { event({ type: "assistant-message", data: assistant }); finish(); });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.messages.at(-1)?.id).toBe(assistant.id);
});

it("aborts reception and ignores late events after leaving the conversation", async () => {
  const { result, unmount } = renderHook(() => useZaiwenChat(session, history()));
  await waitFor(() => expect(result.current.model).toBe("model"));
  let accepted!: Promise<boolean>;
  act(() => { accepted = result.current.send("继续"); });
  const signal = vi.mocked(streamZaiwenMessage).mock.calls[0][4];
  unmount();
  expect(signal.aborted).toBe(true);
  await expect(accepted).resolves.toBe(false);
  await act(async () => { event({ type: "assistant-message", data: assistant }); finish(); });
  expect(refresh).not.toHaveBeenCalled();
});

it("retries model loading and never enables send with an unknown model", async () => {
  vi.mocked(listZaiwenChatModels).mockRejectedValueOnce(new Error("模型加载失败"));
  const { result } = renderHook(() => useZaiwenChat(session, history()));
  await waitFor(() => expect(result.current.modelError).toBe("模型加载失败"));
  await expect(result.current.send("继续")).resolves.toBe(false);
  act(() => result.current.retryModels());
  await waitFor(() => expect(result.current.model).toBe("model"));
  expect(result.current.modelError).toBe("");
});
