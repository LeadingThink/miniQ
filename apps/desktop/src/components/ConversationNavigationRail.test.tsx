// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "../types";
import { ConversationNavigationRail } from "./ConversationNavigationRail";

afterEach(cleanup);

const messages: Message[] = Array.from({ length: 4 }, (_, index) => ({
  id: `user-${index}`,
  sessionId: "session-1",
  role: "user",
  content: `第 ${index + 1} 个问题`,
  createdAt: `2026-09-08T00:0${index}:00Z`,
}));

it("shows a compact rail after a conversation has several user turns", () => {
  const scrollRef = { current: document.createElement("div") };
  render(<ConversationNavigationRail messages={messages} scrollRef={scrollRef} />);
  expect(screen.getByRole("navigation", { name: "会话中的用户消息" })).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(4);
});

it("jumps to the selected user message", () => {
  const scrollRef = { current: document.createElement("div") };
  const target = document.createElement("div");
  target.dataset.userMessageId = "user-2";
  const scrollIntoView = vi.fn();
  target.scrollIntoView = scrollIntoView;
  scrollRef.current.append(target);
  render(<ConversationNavigationRail messages={messages} scrollRef={scrollRef} />);

  fireEvent.click(screen.getByRole("button", { name: /第 3 条用户消息/ }));
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
});

it("does not take space for short conversations", () => {
  const scrollRef = { current: document.createElement("div") };
  render(<ConversationNavigationRail messages={messages.slice(0, 3)} scrollRef={scrollRef} />);
  expect(screen.queryByRole("navigation", { name: "会话中的用户消息" })).toBeNull();
});
