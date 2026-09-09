export type SheetCell = string | number | boolean | Date | null;
export type SheetSort = {
  column: number;
  direction: "ascending" | "descending";
} | null;
export type SheetFilters = Record<number, string>;
export function cellText(cell: SheetCell | undefined): string {
  return cell instanceof Date ? cell.toLocaleString() : String(cell ?? "");
}

export function spreadsheetView(
  data: SheetCell[][],
  query: string,
  sort: SheetSort,
  filters: SheetFilters = {},
) {
  const needle = query.trim().toLocaleLowerCase();
  const columns = Object.entries(filters)
    .map(
      ([column, text]) =>
        [Number(column), text.trim().toLocaleLowerCase()] as const,
    )
    .filter(([, text]) => text.length > 0);
  const rows = data
    .map((cells, index) => ({ cells, number: index + 1 }))
    .filter(
      (row) =>
        (!needle ||
          row.cells.some((cell) =>
            cellText(cell).toLocaleLowerCase().includes(needle),
          )) &&
        columns.every(([column, text]) =>
          cellText(row.cells[column]).toLocaleLowerCase().includes(text),
        ),
    );
  if (!sort) return rows;
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return rows.sort((left, right) => {
    const a = left.cells[sort.column],
      b = right.cells[sort.column];
    const emptyA = a == null || a === "",
      emptyB = b == null || b === "";
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    if (emptyA && emptyB) return left.number - right.number;
    const comparison =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : a instanceof Date && b instanceof Date
          ? a.getTime() - b.getTime()
          : collator.compare(cellText(a), cellText(b));
    return (
      (sort.direction === "ascending" ? comparison : -comparison) ||
      left.number - right.number
    );
  });
}
