/** "3 分钟" / "2 小时" / "5 天" style relative age for a RFC3339 timestamp. */
export function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} 周`;
  return new Date(then).toLocaleDateString();
}

/** Absolute local date-time for tooltips and schedule next-run display. */
export function localDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

/** Calendar days in the viewer's timezone, including 23/25-hour DST days. */
function calendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

// Reusing formatters matters when a long conversation streams a new token.
const clockFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const weekdayFormat = new Intl.DateTimeFormat("zh-CN", { weekday: "long" });
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });
const yearDateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const fullFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "long", day: "numeric", weekday: "long",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
});

export function conversationTimestamp(iso: string, now = new Date()): { label: string; full: string } | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const clock = clockFormat.format(date);
  const days = calendarDay(now) - calendarDay(date);
  const day = days === 0 ? "" : days === 1 ? "昨天"
    : days > 1 && days < 7 ? weekdayFormat.format(date)
      : (date.getFullYear() !== now.getFullYear() ? yearDateFormat : dateFormat).format(date);
  return {
    label: day ? `${day} ${clock}` : clock,
    full: fullFormat.format(date),
  };
}

/** Keep wall-clock timestamps distinct from measured execution durations. */
export function formatDuration(elapsedMs: number): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (elapsedMs < 1_000) return "不足 1 秒";
  let seconds = Math.floor(elapsedMs / 1_000);
  const parts: string[] = [];
  for (const [unit, size] of [["天", 86_400], ["小时", 3_600], ["分", 60], ["秒", 1]] as const) {
    const value = Math.floor(seconds / size);
    if (value) parts.push(`${value} ${unit}`);
    seconds %= size;
  }
  return parts.join(" ");
}

/** Sparse separators: a new calendar day or a substantial break in conversation. */
export function showConversationTimestamp(at: string, previous?: string, now = new Date()): boolean {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return false;
  if (!previous) return now.getTime() - date.getTime() >= 3_600_000 || calendarDay(date) !== calendarDay(now);
  const before = new Date(previous);
  if (!Number.isFinite(before.getTime())) return true;
  return calendarDay(date) !== calendarDay(before) || date.getTime() - before.getTime() >= 3_600_000;
}
