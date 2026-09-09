import { expect, it } from "vitest";
import { parseDelimited } from "./delimitedPreview";

it("preserves quoted commas, newlines, double quotes, leading zeros and formula text", () => {
  expect(
    parseDelimited(
      '\uFEFF编号,说明,数值\r\n001,"两行\n含,逗号和""引号""",=SUM(A1:A2)\r\n',
      ",",
    ),
  ).toEqual([
    ["编号", "说明", "数值"],
    ["001", '两行\n含,逗号和"引号"', "=SUM(A1:A2)"],
  ]);
});
it("preserves blank cells and all rows in tab-delimited files", () => {
  expect(parseDelimited("a\tb\n\t\n0\t", "\t")).toEqual([
    ["a", "b"],
    ["", ""],
    ["0", ""],
  ]);
  expect(parseDelimited("1,2\n".repeat(10001), ",")).toHaveLength(10001);
});
it("reports malformed quotes without dropping content silently", () => {
  expect(() => parseDelimited('a,"unfinished', ",")).toThrow(
    "Quote Not Closed",
  );
});

it("supports mixed platform line endings without altering line breaks inside quoted cells", () => {
  expect(parseDelimited('a,b\r\n1,2\n3,4\r5,"6\r\n7"\n\n', ",")).toEqual([
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
    ["5", "6\r\n7"],
    [""],
  ]);
});
