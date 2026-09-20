// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { MOBILE_CHAT_STORAGE_KEY, mobileMessageText, persistMobileChat, readMobileChat, textChatModels } from "./mobileChatData";

afterEach(() => localStorage.clear());

it("uses explicit chat metadata, retains custom names and deduplicates the model catalog", () => {
  expect(textChatModels({ data: [
    { id: "speech-chat-custom", model_type: "chat" },
    { id: "alpha", model_type: "chat" }, { id: "alpha", model_type: "chat" },
    { id: "image-model", model_type: "image" }, { id: "veo", model_type: "video" },
    { id: "unknown" }, { model_type: "chat" }, null,
  ] })).toEqual(["alpha", "speech-chat-custom"]);
});

it("rejects invalid catalogs instead of silently exposing nonexistent models", () => {
  expect(() => textChatModels({ error: "bad key" })).toThrow("模型列表格式无效");
  expect(textChatModels({ data: [] })).toEqual([]);
});

it("keeps shared history while rejecting malformed or unsafe persisted messages", () => {
  localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, JSON.stringify([
    { role: "user", content: "问题" },
    { role: "assistant", content: "部分回答", status: "interrupted" },
    { role: "admin", content: "wrong" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "javascript:bad()" } }] },
    { role: "user", content: [{ type: "text" }] },
  ]));
  const messages = readMobileChat();
  expect(messages.map(({ role, content, status }) => ({ role, content, ...(status ? { status } : {}) }))).toEqual([
    { role: "user", content: "问题" },
    { role: "assistant", content: "部分回答", status: "interrupted" },
  ]);
  expect(messages[0].id).toBeTruthy();
  expect(messages[1].replyTo).toBe(messages[0].id);
  expect(new Set(messages.map(({ id }) => id)).size).toBe(2);
  persistMobileChat(messages);
  expect(readMobileChat()).toEqual(messages);
});

it("preserves an answer's association after its question is deleted", () => {
  localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, JSON.stringify([
    { id: "old-question", role: "user", content: "较早的问题" },
    { id: "answer", role: "assistant", replyTo: "deleted-question", content: "部分回答", status: "failed" },
  ]));
  expect(readMobileChat()[1].replyTo).toBe("deleted-question");
});

it("persists recorded timestamps and elapsed time without inventing timing for older messages", () => {
  const timed = { id: "answer", role: "assistant" as const, content: "答案", createdAt: "2026-09-20T08:00:00.000Z",
    completedAt: "2026-09-20T08:01:12.000Z", elapsedMs: 72_000 };
  persistMobileChat([{ id: "old", role: "user", content: "旧提问" }, timed]);
  const [old, answer] = readMobileChat();
  expect(old).not.toHaveProperty("createdAt");
  expect(old).not.toHaveProperty("elapsedMs");
  expect(answer).toEqual({ ...timed, replyTo: "old" });
});

it("retains message contents when optional persisted timing is malformed", () => {
  localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, JSON.stringify([
    { id: "question", role: "user", content: "保留问题", createdAt: "not a date" },
    { id: "answer", role: "assistant", content: "保留答案", completedAt: 123, elapsedMs: -5 },
  ]));
  const [question, answer] = readMobileChat();
  expect(question).toEqual({ id: "question", role: "user", content: "保留问题" });
  expect(answer).toEqual({ id: "answer", role: "assistant", content: "保留答案", replyTo: "question" });
});

it("copies all text parts without exposing inline image data as text", () => {
  expect(mobileMessageText("# 原始 Markdown\n\n正文")).toBe("# 原始 Markdown\n\n正文");
  expect(mobileMessageText([
    { type: "text", text: "第一段" },
    { type: "image_url", image_url: { url: "data:image/png;base64,example" } },
    { type: "text", text: "第二段" },
  ])).toBe("第一段\n第二段");
});
