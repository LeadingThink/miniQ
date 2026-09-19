import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Message } from "../types";

interface ConversationNavigationRailProps {
  messages: Message[];
  scrollRef: RefObject<HTMLDivElement | null>;
}

const MIN_MESSAGES_FOR_RAIL = 4;

function messageLabel(message: Message, position: number): string {
  const preview = message.content.replace(/\s+/g, " ").trim();
  return preview
    ? `跳转到第 ${position} 条用户消息：${preview}`
    : `跳转到第 ${position} 条用户消息`;
}

function useRailPosition(
  userMessages: Message[],
  scrollRef: ConversationNavigationRailProps["scrollRef"],
) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hasGutter, setHasGutter] = useState(false);
  const elements = useRef(new Map<string, HTMLElement>());

  // The timeline is a later sibling, so its ref is attached only after this
  // component's layout effects. Subscribe after every sibling has mounted.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || userMessages.length < MIN_MESSAGES_FOR_RAIL) return;
    const content = root.querySelector<HTMLElement>(".timeline-inner");
    // Resolve the DOM once per rendered history change, not once per message
    // on every scroll event. Dataset lookup also accepts arbitrary message IDs.
    elements.current = new Map(
      Array.from(root.querySelectorAll<HTMLElement>("[data-user-message-id]"))
        .map((element) => [element.dataset.userMessageId!, element]),
    );
    let frame: number | null = null;
    const updateActive = () => {
      frame = null;
      const rootRect = root.getBoundingClientRect();
      // Use the actual conversation gutter: a wide window may still contain
      // a narrow conversation when the artifact/browser pane is open.
      const availableGutter = content
        ? content.getBoundingClientRect().left - rootRect.left
        : 0;
      setHasGutter(availableGutter >= 48);
      if (availableGutter < 48) return;
      const center = rootRect.top + root.clientHeight / 2;
      let closest: { id: string; distance: number } | null = null;
      for (const message of userMessages) {
        const element = elements.current.get(message.id);
        if (!element) continue;
        const distance = Math.abs(element.getBoundingClientRect().top - center);
        if (!closest || distance < closest.distance)
          closest = { id: message.id, distance };
      }
      if (closest) setActiveId(closest.id);
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateActive);
    };
    root.addEventListener("scroll", scheduleUpdate, { passive: true });
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleUpdate);
    observer?.observe(root);
    for (const child of root.children) observer?.observe(child);
    updateActive();
    return () => {
      root.removeEventListener("scroll", scheduleUpdate);
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      elements.current.clear();
    };
  }, [scrollRef, userMessages]);
  return { activeId, hasGutter, elements };
}

export function ConversationNavigationRail({
  messages,
  scrollRef,
}: ConversationNavigationRailProps) {
  const userMessages = useMemo(
    () => messages.filter((message) => message.role === "user"),
    [messages],
  );
  const { activeId, hasGutter, elements } = useRailPosition(userMessages, scrollRef);
  const railRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const preview = userMessages.find((message) => message.id === (hoverId ?? focusId));

  useEffect(() => {
    const list = railRef.current;
    const marker = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !marker) return;
    const listRect = list.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    if (markerRect.top < listRect.top) list.scrollTop -= listRect.top - markerRect.top;
    else if (markerRect.bottom > listRect.bottom)
      list.scrollTop += markerRect.bottom - listRect.bottom;
  }, [activeId, hasGutter, userMessages]);

  if (userMessages.length < MIN_MESSAGES_FOR_RAIL || !hasGutter) return null;

  const jumpToMessage = (id: string) => {
    const root = scrollRef.current;
    const element = elements.current.get(id);
    if (!root || !element) return;
    const rect = element.getBoundingClientRect();
    root.scrollTo({
      top: root.scrollTop + rect.top - root.getBoundingClientRect().top
        - (root.clientHeight - rect.height) / 2,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  return (
    <nav
      className="conversation-navigation-rail"
      aria-label="会话中的用户消息"
      onMouseLeave={() => setHoverId(null)}
    >
      <div className="conversation-navigation-list" ref={railRef}>
        {userMessages.map((message, index) => (
          <button
            key={message.id}
            type="button"
            className="conversation-navigation-marker"
            aria-label={messageLabel(message, index + 1)}
            aria-current={activeId === message.id ? "true" : undefined}
            onMouseEnter={() => setHoverId(message.id)}
            onFocus={() => setFocusId(message.id)}
            onBlur={() => setFocusId(null)}
            onClick={() => jumpToMessage(message.id)}
          />
        ))}
      </div>
      {preview && (
        <div className="conversation-navigation-preview" aria-hidden="true">
          {preview.content || preview.attachments?.map((attachment) => attachment.name).join("、") || "附件消息"}
        </div>
      )}
    </nav>
  );
}
