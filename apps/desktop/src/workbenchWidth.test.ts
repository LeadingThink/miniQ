import { describe, expect, it } from "vitest";
import {
  clampWorkbenchWidth,
  DEFAULT_WORKBENCH_WIDTH,
  MAX_WORKBENCH_WIDTH,
  MIN_WORKBENCH_WIDTH,
  readWorkbenchWidth,
} from "./workbenchWidth";

describe("workbench width", () => {
  it("keeps the panel within desktop layout bounds", () => {
    expect(clampWorkbenchWidth(100, 1728, false)).toBe(MIN_WORKBENCH_WIDTH);
    expect(clampWorkbenchWidth(1200, 1728, false)).toBe(MAX_WORKBENCH_WIDTH);
    expect(clampWorkbenchWidth(700, 1200, false)).toBe(496);
    expect(clampWorkbenchWidth(700, 1200, true)).toBe(700);
  });

  it("restores a valid persisted width and falls back for invalid values", () => {
    expect(readWorkbenchWidth({ getItem: () => "640" }, 1728, false)).toBe(640);
    expect(readWorkbenchWidth({ getItem: () => "invalid" }, 1728, false)).toBe(
      DEFAULT_WORKBENCH_WIDTH,
    );
  });
});
