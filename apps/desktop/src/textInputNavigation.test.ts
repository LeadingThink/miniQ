import { describe, expect, it } from "vitest";
import { navigateTextSelection, sanitizeTextInput } from "./textInputNavigation";

describe("composer text navigation", () => {
  it("moves Home and End within the current line", () => {
    const value = "alpha\nbeta\ngamma";
    const caret = { start: 8, end: 8, direction: "none" as const };

    expect(navigateTextSelection(value, caret, "Home", false, false)).toEqual({
      start: 6,
      end: 6,
      direction: "none",
    });
    expect(navigateTextSelection(value, caret, "End", false, false)).toEqual({
      start: 10,
      end: 10,
      direction: "none",
    });
  });

  it("moves modified Home and End to document boundaries", () => {
    const value = "alpha\nbeta";
    const caret = { start: 7, end: 7, direction: "none" as const };

    expect(navigateTextSelection(value, caret, "Home", false, true).start).toBe(0);
    expect(navigateTextSelection(value, caret, "End", false, true).start).toBe(
      value.length,
    );
  });

  it("handles empty lines and CRLF without selecting the carriage return", () => {
    const value = "alpha\r\n\r\nbeta";

    expect(
      navigateTextSelection(
        value,
        { start: 8, end: 8, direction: "none" },
        "Home",
        false,
        false,
      ).start,
    ).toBe(7);
    expect(
      navigateTextSelection(
        value,
        { start: 7, end: 7, direction: "none" },
        "End",
        false,
        false,
      ).start,
    ).toBe(7);
  });

  it("extends and reverses selections with Shift+Home/End", () => {
    const value = "alpha\nbeta";

    expect(
      navigateTextSelection(
        value,
        { start: 8, end: 8, direction: "none" },
        "Home",
        true,
        false,
      ),
    ).toEqual({ start: 6, end: 8, direction: "backward" });
    expect(
      navigateTextSelection(
        value,
        { start: 6, end: 8, direction: "backward" },
        "End",
        true,
        false,
      ),
    ).toEqual({ start: 8, end: 10, direction: "forward" });
  });

  it("removes WebKit function-key characters and preserves the caret", () => {
    expect(sanitizeTextInput("ab\u0004c\u007Fd", 4, 5)).toEqual({
      value: "abcd",
      start: 3,
      end: 3,
      direction: "none",
      changed: true,
    });
    expect(sanitizeTextInput("ab\uF703cd", 3, 3)).toMatchObject({
      value: "abcd",
      start: 2,
      end: 2,
      changed: true,
    });
  });

  it("preserves tabs, newlines, and normal Unicode text", () => {
    const value = "白泽\tminiQ\n🙂";
    expect(sanitizeTextInput(value)).toMatchObject({ value, changed: false });
  });
});
