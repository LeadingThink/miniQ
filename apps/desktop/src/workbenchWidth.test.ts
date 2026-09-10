import { describe, expect, it } from "vitest";
import {
  clampWorkbenchWidth,
  DEFAULT_WORKBENCH_WIDTH,
  readWorkbenchWidth,
  workbenchLayout,
} from "./workbenchWidth";

describe("workbench width", () => {
  it.each([
    [1200, 1200, "split", 850],
    [936, 1200, "split", 586],
    [736, 1000, "split", 386],
    [536, 800, "overlay", 776],
    [320, 320, "mobile", 296],
    [2200, 2464, "split", 1850],
  ])("fits available %i in viewport %i", (available, viewport, mode, max) => {
    const layout = workbenchLayout(available, viewport);
    expect(layout).toEqual({ mode, min: Math.min(320, max), max });
    expect(clampWorkbenchWidth(9999, layout.min, layout.max)).toBe(max);
    expect(clampWorkbenchWidth(0, layout.min, layout.max)).toBe(layout.min);
  });

  it("keeps the preferred width independent of temporary layout bounds", () => {
    expect(readWorkbenchWidth({ getItem: () => "1440" })).toBe(1440);
    expect(clampWorkbenchWidth(NaN, 320, 900)).toBe(DEFAULT_WORKBENCH_WIDTH);
  });

  it.each([null, "", "invalid", "Infinity", "-10", "0"])(
    "rejects invalid stored width %s",
    (stored) => {
      expect(readWorkbenchWidth({ getItem: () => stored })).toBe(
        DEFAULT_WORKBENCH_WIDTH,
      );
    },
  );
});
