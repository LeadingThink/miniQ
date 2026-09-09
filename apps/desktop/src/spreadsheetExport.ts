import type { SheetCell } from "./spreadsheetView";

function csvCell(cell: SheetCell | undefined) {
  let value = cell instanceof Date ? cell.toISOString() : String(cell ?? "");
  // CSV viewers can execute formula-looking strings. The typed JSON export
  // preserves their exact original values without spreadsheet evaluation.
  if (typeof cell === "string" && /^[\s]*[=+\-@]|^[\t\r\n]/.test(value))
    value = `'${value}`;
  return `"${value.replace(/"/g, '""')}"`;
}

export function spreadsheetCsv(
  rows: { cells: SheetCell[]; number: number }[],
  columns: number,
): Blob {
  const parts: BlobPart[] = ["\uFEFF"];
  for (const row of rows) {
    parts.push(
      Array.from({ length: columns }, (_, index) =>
        csvCell(row.cells[index]),
      ).join(","),
      "\r\n",
    );
  }
  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

export function spreadsheetJson(
  sheets: { sheet: string; data: SheetCell[][] }[],
): Blob {
  const parts: BlobPart[] = ['{"format":"miniq-workbook-v1","sheets":['];
  sheets.forEach((sheet, index) => {
    if (index) parts.push(",");
    parts.push(`{"sheet":${JSON.stringify(sheet.sheet)},"data":[`);
    sheet.data.forEach((row, rowIndex) => {
      if (rowIndex) parts.push(",");
      parts.push(
        JSON.stringify(
          row.map((cell) =>
            cell instanceof Date
              ? { type: "date", value: cell.toISOString() }
              : cell,
          ),
        ),
      );
    });
    parts.push("]}");
  });
  parts.push("]}");
  return new Blob(parts, { type: "application/json;charset=utf-8" });
}
