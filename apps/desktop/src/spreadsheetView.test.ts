import { expect, it } from "vitest";
import { spreadsheetView } from "./spreadsheetView";

it("searches all pages and preserves original row identities", () => {
  const rows = Array.from({ length: 450 }, (_, index) => [
    `row ${index}`,
    index,
  ]);
  expect(spreadsheetView(rows, "ROW 444", null)).toEqual([
    { cells: ["row 444", 444], number: 445 },
  ]);
  expect(rows).toHaveLength(450);
});

it("sorts numerically and stably with blanks last in either direction", () => {
  const rows = [[10], [2], [null], [2], [1], [""]];
  expect(
    spreadsheetView(rows, "", { column: 0, direction: "ascending" }).map(
      (row) => row.number,
    ),
  ).toEqual([5, 2, 4, 1, 3, 6]);
  expect(
    spreadsheetView(rows, "", { column: 0, direction: "descending" }).map(
      (row) => row.number,
    ),
  ).toEqual([1, 2, 4, 5, 3, 6]);
  expect(rows[0][0]).toBe(10);
});

it("retains false, zero and full cell text", () => {
  const text = "long value ".repeat(1000);
  expect(
    spreadsheetView([[false], [0], [text], []], "false", null)[0].cells,
  ).toEqual([false]);
  expect(spreadsheetView([[text]], "value", null)[0].cells[0]).toBe(text);
});

it("combines column filters with global search without changing cell values", () => {
  const data = [
    ["East", "alpha", 0],
    ["West", "alpha", false],
    ["East", "beta", 5],
    [],
  ];
  expect(spreadsheetView(data, "alpha", null, { 0: "EAST", 2: "0" })).toEqual([
    { cells: data[0], number: 1 },
  ]);
  expect(spreadsheetView(data, "", null, { 2: "false" })).toEqual([
    { cells: data[1], number: 2 },
  ]);
  expect(spreadsheetView(data, "", null, { 1: "missing" })).toEqual([]);
  expect(spreadsheetView(data, "", null, { 1: " " })).toHaveLength(4);
});
