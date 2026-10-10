import { describe, expect, it } from "vitest";
import {
  WINDOW_TAIL,
  anchorCorrection,
  estimateTurnHeight,
  isTurnMounted,
  resolveTurnRange,
  visibleTurnRange,
} from "./timelineWindow";

/** Turns of the given heights stacked from `offset` (viewport coordinates). */
function boxes(heights: number[], offset = 0) {
  const result: { top: number; bottom: number }[] = [];
  let top = offset;
  for (const height of heights) {
    result.push({ top, bottom: top + height });
    top += height;
  }
  return (index: number) => result[index];
}

describe("visibleTurnRange", () => {
  it("finds turns intersecting the viewport plus overscan", () => {
    const box = boxes(Array(100).fill(100), -2_000);
    // Viewport 0..500 covers turns 20-24; 300px overscan adds 3 on each side.
    expect(visibleTurnRange(100, box, 0, 500, 300)).toEqual({ start: 17, end: 27 });
    expect(visibleTurnRange(100, box, 0, 500, 0)).toEqual({ start: 20, end: 24 });
  });

  it("handles uneven heights and views beyond either end", () => {
    const box = boxes([50, 1_000, 50, 50]);
    expect(visibleTurnRange(4, box, 200, 300, 0)).toEqual({ start: 1, end: 1 });
    expect(visibleTurnRange(4, box, 5_000, 5_500, 0)).toEqual({ start: 3, end: 3 });
    expect(visibleTurnRange(2, boxes([50, 50], 1_000), 0, 100, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleTurnRange(0, box, 0, 100, 0)).toBeNull();
  });
});

describe("turn window bookkeeping", () => {
  const keys = ["a", "b", "c", "d", "e", "f"];

  it("resolves ranges by key so prepended pages keep the same turns mounted", () => {
    const range = { startKey: "c", endKey: "d", span: 1 };
    expect(resolveTurnRange(keys, range)).toEqual({ start: 2, end: 3 });
    expect(resolveTurnRange(["x", "y", ...keys], range)).toEqual({ start: 4, end: 5 });
    // A page that began mid-turn changes the first turn's key.
    expect(resolveTurnRange(["c2", "d", "e"], range)).toEqual({ start: 0, end: 1 });
    expect(resolveTurnRange(["c", "x", "y"], range)).toEqual({ start: 0, end: 1 });
    expect(resolveTurnRange(["x"], range)).toBeNull();
    expect(resolveTurnRange(keys, null)).toBeNull();
  });

  it("always mounts the newest turns, and everything before the first measurement", () => {
    const range = { start: 1, end: 2 };
    const mounted = keys.map((_, index) => isTurnMounted(index, keys.length, range));
    expect(WINDOW_TAIL).toBe(2);
    expect(mounted).toEqual([false, true, true, false, true, true]);
    expect(keys.every((_, index) => isTurnMounted(index, keys.length, null))).toBe(true);
  });

  it("estimates unmeasured turns from measured ones", () => {
    expect(estimateTurnHeight([])).toBe(360);
    expect(estimateTurnHeight([100, 301])).toBe(201);
  });

  it("corrects scrolling only for height changes above the reader", () => {
    const base = { viewportTop: 100, previousHeight: 300, height: 500 };
    // A placeholder above the viewport top becomes a taller real turn.
    expect(anchorCorrection({ ...base, top: -50, replacedPlaceholder: true })).toBe(200);
    expect(anchorCorrection({ ...base, top: 150, replacedPlaceholder: true })).toBe(0);
    // A mounted turn straddling the top (e.g. a fold the reader opened) stays put.
    expect(anchorCorrection({ ...base, top: -50, replacedPlaceholder: false })).toBe(0);
    expect(anchorCorrection({ ...base, top: -250, replacedPlaceholder: false })).toBe(200);
    expect(anchorCorrection({ ...base, top: -250, height: 300, replacedPlaceholder: false })).toBe(0);
  });
});
