export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
export interface PdfTextPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}
export interface PdfTextDocument {
  numPages: number;
  getPage(page: number): Promise<PdfTextPage>;
}
export interface PdfMatch {
  page: number;
  count: number;
}

export function pdfText(items: PdfTextItem[]): string {
  return items.map((item) => (typeof item.str === "string" ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
}

export async function searchPdf(
  document: PdfTextDocument,
  query: string,
  signal: AbortSignal,
  progress: (page: number) => void,
): Promise<PdfMatch[]> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: PdfMatch[] = [];
  for (let page = 1; page <= document.numPages; page++) {
    signal.throwIfAborted();
    const current = await document.getPage(page);
    signal.throwIfAborted();
    const text = pdfText((await current.getTextContent()).items).toLocaleLowerCase();
    signal.throwIfAborted();
    let count = 0;
    for (let position = text.indexOf(needle); position >= 0; position = text.indexOf(needle, position + needle.length))
      count++;
    if (count) matches.push({ page, count });
    progress(page);
  }
  return matches;
}
