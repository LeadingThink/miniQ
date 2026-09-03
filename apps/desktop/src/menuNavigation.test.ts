import { describe, expect, it } from "vitest";
import { clampMenuIndex, moveMenuIndex } from "./menuNavigation";

describe("menu keyboard navigation", () => {
  it("wraps at both ends", () => {
    expect(moveMenuIndex(2, 3, 1)).toBe(0);
    expect(moveMenuIndex(0, 3, -1)).toBe(2);
  });

  it("selects the appropriate edge from an unset index", () => {
    expect(moveMenuIndex(-1, 3, 1)).toBe(0);
    expect(moveMenuIndex(-1, 3, -1)).toBe(2);
  });

  it("handles empty and shrinking menus", () => {
    expect(moveMenuIndex(0, 0, 1)).toBe(-1);
    expect(clampMenuIndex(8, 3)).toBe(2);
    expect(clampMenuIndex(0, 0)).toBe(-1);
  });
});
