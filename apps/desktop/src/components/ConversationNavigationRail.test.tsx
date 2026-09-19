// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "../types";
import { ConversationNavigationRail } from "./ConversationNavigationRail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const messages: Message[] = Array.from({ length: 4 }, (_, index) => ({
  id: `user-${index}`,
  sessionId: "session-1",
  role: "user",
  content: `第 ${index + 1} 个问题`,
  createdAt: `2026-09-08T00:0${index}:00Z`,
}));

function createScrollRef(gutter = 64, history = messages) {
  const root = document.createElement("div");
  const content = document.createElement("div");
  content.className = "timeline-inner";
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 200));
  vi.spyOn(content, "getBoundingClientRect").mockReturnValue(new DOMRect(gutter, 0, 820, 1000));
  Object.defineProperty(root, "clientHeight", { value: 200 });
  root.scrollTo = vi.fn();
  for (const [index, message] of history.entries()) {
    const target = document.createElement("div");
    target.dataset.userMessageId = message.id;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(gutter, index * 200, 600, 60));
    content.append(target);
  }
  root.append(content);
  return { current: root };
}

it("shows a compact rail after a conversation has several user turns", () => {
  const scrollRef = createScrollRef();
  render(<ConversationNavigationRail messages={messages} scrollRef={scrollRef} />);
  expect(screen.getByRole("navigation", { name: "会话中的用户消息" })).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(4);
});

it("mounts with the timeline sibling ref initially null without another message update", () => {
  const scrollRef = { current: null as HTMLDivElement | null };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("timeline")) return new DOMRect(0, 0, 1000, 200);
    if (this.classList.contains("timeline-inner")) return new DOMRect(64, 0, 820, 1000);
    const index = messages.findIndex((message) => message.id === this.dataset.userMessageId);
    return index >= 0 ? new DOMRect(64, index * 200, 600, 60) : new DOMRect();
  });

  render(
    <div className="timeline-shell">
      <ConversationNavigationRail messages={messages} scrollRef={scrollRef} />
      <div className="timeline" ref={scrollRef}>
        <div className="timeline-inner">
          {messages.map((message) => (
            <div key={message.id} data-user-message-id={message.id}>{message.content}</div>
          ))}
        </div>
      </div>
    </div>,
  );

  expect(screen.getByRole("navigation", { name: "会话中的用户消息" })).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(4);
  const root = scrollRef.current!;
  root.scrollTo = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: /第 3 条用户消息/ }));
  expect(root.scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 430 });
});

it("jumps inside the conversation without scrolling its ancestors", () => {
  const scrollRef = createScrollRef();
  render(<ConversationNavigationRail messages={messages} scrollRef={scrollRef} />);

  fireEvent.click(screen.getByRole("button", { name: /第 3 条用户消息/ }));
  expect(scrollRef.current.scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 330 });
});

it("does not take space for short conversations", () => {
  const scrollRef = createScrollRef();
  render(<ConversationNavigationRail messages={messages.slice(0, 3)} scrollRef={scrollRef} />);
  expect(screen.queryByRole("navigation", { name: "会话中的用户消息" })).toBeNull();
});

it("respects reduced motion and accepts arbitrary message identifiers", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  const history = messages.map((message, index) => index === 2
    ? { ...message, id: 'special"\\\n[]' }
    : message);
  const scrollRef = createScrollRef(64, history);
  render(<ConversationNavigationRail messages={history} scrollRef={scrollRef} />);
  fireEvent.click(screen.getByRole("button", { name: /第 3 条用户消息/ }));
  expect(scrollRef.current.scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 330 });
});

it("shows full prompt previews for both pointer and keyboard navigation", () => {
  const fullText = "完整问题内容。".repeat(50);
  const history = messages.map((message, index) => index === 0
    ? { ...message, content: fullText }
    : message);
  const scrollRef = createScrollRef(64, history);
  render(<ConversationNavigationRail messages={history} scrollRef={scrollRef} />);
  const marker = screen.getByRole("button", { name: `跳转到第 1 条用户消息：${fullText}` });
  fireEvent.mouseEnter(marker);
  expect(screen.getByText(fullText)).toBeTruthy();
  fireEvent.mouseLeave(screen.getByRole("navigation"));
  expect(screen.queryByText(fullText)).toBeNull();
  fireEvent.focus(marker);
  expect(screen.getByText(fullText)).toBeTruthy();
  fireEvent.blur(marker);
  expect(screen.queryByText(fullText)).toBeNull();
});

it("coalesces scroll bursts and caches DOM lookups", () => {
  let frame: FrameRequestCallback | undefined;
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  const scrollRef = createScrollRef();
  const queries = vi.spyOn(scrollRef.current, "querySelectorAll");
  render(<ConversationNavigationRail messages={messages} scrollRef={scrollRef} />);
  queries.mockClear();
  fireEvent.scroll(scrollRef.current);
  fireEvent.scroll(scrollRef.current);
  fireEvent.scroll(scrollRef.current);
  expect(requestFrame).toHaveBeenCalledTimes(1);
  act(() => frame?.(0));
  expect(queries).not.toHaveBeenCalled();
});

it("hides the rail when resizing leaves no conversation gutter", () => {
  let resize: (() => void) | undefined;
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  const scrollRef = createScrollRef();
  render(<ConversationNavigationRail messages={messages} scrollRef={scrollRef} />);
  expect(screen.getByRole("navigation")).toBeTruthy();
  const content = scrollRef.current.firstElementChild!;
  vi.mocked(content.getBoundingClientRect).mockReturnValue(new DOMRect(20, 0, 700, 1000));
  act(() => { resize?.(); frame?.(0); });
  expect(screen.queryByRole("navigation")).toBeNull();
  vi.mocked(content.getBoundingClientRect).mockReturnValue(new DOMRect(64, 0, 820, 1000));
  act(() => { resize?.(); frame?.(0); });
  expect(screen.getByRole("navigation")).toBeTruthy();
});

it("keeps the active marker visible without moving the conversation", () => {
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  const scrollRef = createScrollRef();
  const { container } = render(<ConversationNavigationRail messages={messages} scrollRef={scrollRef} />);
  const list = container.querySelector<HTMLElement>(".conversation-navigation-list")!;
  const marker = screen.getByRole("button", { name: /第 2 条用户消息/ });
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 30, 100));
  vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 150, 30, 24));
  const target = scrollRef.current.querySelector<HTMLElement>('[data-user-message-id="user-1"]')!;
  vi.mocked(target.getBoundingClientRect).mockReturnValue(new DOMRect(64, 100, 600, 60));
  fireEvent.scroll(scrollRef.current);
  act(() => frame?.(0));
  expect(marker.getAttribute("aria-current")).toBe("true");
  expect(list.scrollTop).toBe(74);
  expect(scrollRef.current.scrollTo).not.toHaveBeenCalled();
});
