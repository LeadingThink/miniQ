import { expect, it } from "vitest";
import { spreadsheetCsv, spreadsheetJson } from "./spreadsheetExport";
import type { SheetCell } from "./spreadsheetView";

it("exports all matching rows, quotes CSV, and neutralizes formula strings only", async () => {
  const rows = Array.from({ length: 450 }, (_, index) => ({
    number: index + 1,
    cells: [index, 'a,"b"\nc'],
  }));
  const csv = await spreadsheetCsv(rows, 2).text();
  expect(csv).toContain('"449","a,""b""\nc"\r\n');
  const dangerous: SheetCell[] = [
    "=SUM(A1)",
    " @cmd",
    "-formula",
    -3,
    false,
    0,
    null,
  ];
  expect(
    await spreadsheetCsv([{ number: 1, cells: dangerous }], 7).text(),
  ).toContain('"\'=SUM(A1)","\' @cmd","\'-formula","-3","false","0",""');
});

it("JSON retains all sheets, original formula strings, long values and date types", async () => {
  const long = "中文".repeat(8000);
  const sheets = [
    {
      sheet: "one",
      data: [["=1+1", false, 0, long, new Date("2026-09-09T00:00:00Z")]],
    },
    { sheet: "two", data: [[]] },
  ];
  const data = JSON.parse(await spreadsheetJson(sheets).text());
  expect(data.sheets[0].data[0]).toEqual([
    "=1+1",
    false,
    0,
    long,
    { type: "date", value: "2026-09-09T00:00:00.000Z" },
  ]);
  expect(data.sheets[1]).toEqual(sheets[1]);
});
