import { useEffect, useMemo, useState, type RefObject } from "react";
import type { Message } from "../types";

interface ConversationNavigationRailProps {
  messages: Message[];
  scrollRef: RefObject<HTMLDivElement | null>;
}

const MIN_MESSAGES_FOR_RAIL = 4;

function escapeSelector(value: string): string {
  const escape = globalThis.CSS?.escape;
  return escape ? escape(value) : value.replace(/["\\]/g, "\\$&");
}

function messageLabel(message: Message, position: number): string {
  const preview = message.content.replace(/\s+/g, " ").trim();
  return preview
    ? `跳转到第 ${position} 条用户消息：${preview.slice(0, 80)}`
    : `跳转到第 ${position} 条用户消息`;
}

export function ConversationNavigationRail({
  messages,
  scrollRef,
}: ConversationNavigationRailProps) {
  const userMessages = useMemo(
    () => messages.filter((message) => message.role === "user"),
    [messages],
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || userMessages.length < MIN_MESSAGES_FOR_RAIL) return;
    const updateActive = () => {
      const rootRect = root.getBoundingClientRect();
      const center = rootRect.top + root.clientHeight / 2;
      let closest: { id: string; distance: number } | null = null;
      for (const message of userMessages) {
        const element = root.querySelector<HTMLElement>(
          `[data-user-message-id="${escapeSelector(message.id)}"]`,
        );
        if (!element) continue;
        const distance = Math.abs(element.getBoundingClientRect().top - center);
        if (!closest || distance < closest.distance)
          closest = { id: message.id, distance };
      }
      if (closest) setActiveId(closest.id);
    };
    root.addEventListener("scroll", updateActive, { passive: true });
    const frame = window.requestAnimationFrame(updateActive);
    return () => {
      root.removeEventListener("scroll", updateActive);
      window.cancelAnimationFrame(frame);
    };
  }, [scrollRef, userMessages]);

  if (userMessages.length < MIN_MESSAGES_FOR_RAIL) return null;

  return (
    <nav className="conversation-navigation-rail" aria-label="会话中的用户消息">
      <div className="conversation-navigation-list">
        {userMessages.map((message, index) => (
          <button
            key={message.id}
            type="button"
            className="conversation-navigation-marker"
            aria-label={messageLabel(message, index + 1)}
            aria-current={activeId === message.id ? "true" : undefined}
            title={messageLabel(message, index + 1)}
            onClick={() => {
              const element = scrollRef.current?.querySelector<HTMLElement>(
                `[data-user-message-id="${escapeSelector(message.id)}"]`,
              );
              element?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          />
        ))}
      </div>
    </nav>
  );
}
