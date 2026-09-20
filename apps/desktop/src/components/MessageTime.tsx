import { conversationTimestamp } from "../time";
import { memo } from "react";
import { useCalendarDay } from "../hooks/useCalendarDay";
import "./MessageTime.css";

/** Native disclosure works with hover, keyboard and touch without a floating overlay. */
export const MessageTime = memo(function MessageTime({ at }: { at: string | undefined }) {
  useCalendarDay();
  const value = at ? conversationTimestamp(at) : null;
  if (!value) return null;
  return <details className="message-time">
    <summary className="message-time-trigger" title={value.full} aria-label={`查看完整时间：${value.full}`}>
      <time dateTime={at}>{value.label}</time>
    </summary>
    <span className="message-time-detail">{value.full}</span>
  </details>;
});

export const ConversationTimeSeparator = memo(function ConversationTimeSeparator({ at }: { at: string }) {
  useCalendarDay();
  const value = conversationTimestamp(at);
  if (!value) return null;
  return <div className="conversation-time-separator" role="separator" aria-label={value.full}>
    <time dateTime={at} title={value.full}>{value.label}</time>
  </div>;
});
