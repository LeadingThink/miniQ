import { describe, expect, it } from "vitest";
import { conversationTimestamp, formatDuration, showConversationTimestamp } from "./time";

describe("conversation time", () => {
  const now = new Date(2026, 8, 20, 14, 30);
  const at = (year: number, month: number, day: number, hour = 10, minute = 15) => new Date(year, month - 1, day, hour, minute).toISOString();
  it("uses local calendar days, 24-hour minutes, and explicit years across a year boundary", () => {
    expect(conversationTimestamp(at(2026, 9, 20), now)?.label).toBe("10:15");
    expect(conversationTimestamp(at(2026, 9, 19), now)?.label).toBe("昨天 10:15");
    expect(conversationTimestamp(at(2026, 9, 18), now)?.label).toBe("星期五 10:15");
    expect(conversationTimestamp(at(2026, 9, 1), now)?.label).toBe("9月1日 10:15");
    expect(conversationTimestamp(at(2025, 9, 20), now)?.label).toBe("2025年9月20日 10:15");
    expect(conversationTimestamp(at(2026, 9, 20), now)?.full).toContain("2026年9月20日");
    expect(conversationTimestamp("invalid", now)).toBeNull();
  });
  it("shows separators for day changes and long breaks, not every short exchange", () => {
    expect(showConversationTimestamp(at(2026, 9, 20, 14, 0), undefined, now)).toBe(false);
    expect(showConversationTimestamp(at(2026, 9, 20, 10, 0), undefined, now)).toBe(true);
    expect(showConversationTimestamp(at(2026, 9, 20, 10, 30), at(2026, 9, 20, 10, 0), now)).toBe(false);
    expect(showConversationTimestamp(at(2026, 9, 20, 11, 0), at(2026, 9, 20, 10, 0), now)).toBe(true);
    expect(showConversationTimestamp(at(2026, 9, 20, 0, 1), at(2026, 9, 19, 23, 59), now)).toBe(true);
  });
  it("uses calendar dates rather than elapsed hours around daylight saving changes", () => {
    // Run this test with TZ=America/New_York too: the previous day is 23 hours long.
    const spring = new Date(2026, 2, 9, 0, 10);
    const yesterday = new Date(2026, 2, 8, 0, 5);
    expect(conversationTimestamp(yesterday.toISOString(), spring)?.label).toBe("昨天 00:05");
  });
});

describe("durations", () => {
  it.each([
    [0, "不足 1 秒"], [999, "不足 1 秒"], [59_999, "59 秒"], [60_000, "1 分"],
    [3_661_000, "1 小时 1 分 1 秒"], [90_060_000, "1 天 1 小时 1 分"],
    [-1, null], [NaN, null], [Infinity, null],
  ])("formats %s ms without rounding into the next unit", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
