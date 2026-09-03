export const PDF_MIN_ZOOM = 0.6;
export const PDF_MAX_ZOOM = 2;
export const PDF_ZOOM_STEP = 0.2;

export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(Math.trunc(page), 1), Math.max(1, Math.trunc(pageCount)));
}

export function clampPdfZoom(zoom: number): number {
  const clamped = Math.min(Math.max(zoom, PDF_MIN_ZOOM), PDF_MAX_ZOOM);
  return Math.round(clamped * 10) / 10;
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

export function moveTabIndex(index: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  return (index + direction + count) % count;
}
