import { expect, it } from "vitest";
import { fuzzyMatch, highlightSegments } from "./fuzzyMatch";

it("ranks prefix above substring above subsequence", () => {
  const prefix = fuzzyMatch("Settings", "set")!;
  const substring = fuzzyMatch("Reset all", "set")!;
  const subsequence = fuzzyMatch("Save each test", "set")!;
  expect(prefix.score).toBeGreaterThan(substring.score);
  expect(substring.score).toBeGreaterThan(subsequence.score);
  expect(prefix.indices).toEqual([0, 1, 2]);
});

it("is case-insensitive, handles CJK and rejects misses", () => {
  expect(fuzzyMatch("打开设置", "设置")).not.toBeNull();
  expect(fuzzyMatch("MCP", "mcp")).not.toBeNull();
  expect(fuzzyMatch("abc", "xyz")).toBeNull();
  expect(fuzzyMatch("abc", "")).toEqual({ score: 0, indices: [] });
});

it("splits highlighted segments", () => {
  expect(highlightSegments("abcd", [1, 2])).toEqual([
    { text: "a", match: false },
    { text: "bc", match: true },
    { text: "d", match: false },
  ]);
});
