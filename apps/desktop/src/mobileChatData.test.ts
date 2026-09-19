// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { MOBILE_CHAT_STORAGE_KEY, readMobileChat, textChatModels } from "./mobileChatData";

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
  expect(readMobileChat()).toEqual([
    { role: "user", content: "问题" },
    { role: "assistant", content: "部分回答", status: "interrupted" },
  ]);
});
