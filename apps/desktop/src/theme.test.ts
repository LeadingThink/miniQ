import { describe, expect, it } from "vitest";
import { isThemeId, resolveTheme, THEMES } from "./theme";

describe("theme selection", () => {
  it("keeps every registered theme id", () => {
    for (const theme of THEMES) {
      expect(isThemeId(theme.id)).toBe(true);
      expect(resolveTheme(theme.id)).toBe(theme.id);
    }
  });

  it("falls back to paper for missing or obsolete values", () => {
    expect(resolveTheme(null)).toBe("paper");
    expect(resolveTheme("unknown-theme")).toBe("paper");
  });
});
