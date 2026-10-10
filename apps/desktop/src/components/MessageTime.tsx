import { conversationTimestamp, turnSeparatorLabel } from "../time";
import { memo } from "react";
import { useCalendarDay } from "../hooks/useCalendarDay";
import "./MessageTime.css";

/** Native disclosure works with hover, keyboard and touch without a floating overlay. */
export const MessageTime = memo(function MessageTime({ at }: { at: string | undefined }) {
  // Labels depend on the current day; useCalendarDay only triggers re-renders.
  "use no memo";
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

/** Centered date-time between turns separated by a long break or a new day. */
export const ConversationTimeSeparator = memo(function ConversationTimeSeparator({ at }: { at: string }) {
  "use no memo";
  useCalendarDay();
  const label = turnSeparatorLabel(at);
  const full = conversationTimestamp(at)?.full;
  if (!label) return null;
  return <div className="conversation-time-separator" role="separator" aria-label={full}>
    <time dateTime={at} title={full}>{label}</time>
  </div>;
});
