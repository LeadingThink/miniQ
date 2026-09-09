export const PDF_MAX_CANVAS_PIXELS = 16_777_216;
export const PDF_MAX_CANVAS_SIDE = 8192;

export function pdfRasterSize(
  width: number,
  height: number,
  devicePixelRatio: number,
) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("PDF 页面尺寸无效");
  }
  const density =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  // Bound raster memory, not document content or the logical zoomed page size.
  const ratio = Math.min(
    density,
    2,
    PDF_MAX_CANVAS_SIDE / width,
    PDF_MAX_CANVAS_SIDE / height,
    Math.sqrt(PDF_MAX_CANVAS_PIXELS / width / height),
  );
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    ratio,
  };
}

export function clampPage(page: number, pageCount: number): number {
  return Math.min(
    Math.max(Math.trunc(page), 1),
    Math.max(1, Math.trunc(pageCount)),
  );
}

export function clampDocumentZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.round(Math.min(Math.max(zoom, 0.1), 4) * 100) / 100;
}

export function spreadsheetColumnLabel(index: number): string {
  let value = Math.max(0, Math.trunc(index)) + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function moveTabIndex(
  index: number,
  count: number,
  direction: -1 | 1,
): number {
  if (count <= 0) return 0;
  return (index + direction + count) % count;
}

export function spreadsheetRow<T>(
  row: T[],
  columnCount: number,
): Array<T | null> {
  return Array.from(
    { length: Math.max(0, columnCount) },
    (_, index) => row[index] ?? null,
  );
}
