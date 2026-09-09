import { parse } from "csv-parse/browser/esm/sync";

export function parseDelimited(content: string, delimiter: "," | "\t") {
  return parse(content, {
    delimiter,
    record_delimiter: ["\r\n", "\n", "\r"],
    bom: true,
    cast: false,
    relax_column_count: true,
    skip_empty_lines: false,
  }) as string[][];
}
