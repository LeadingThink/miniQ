/** Long conversations mount only turns near the viewport. Shorter ones render
 * every turn: the bookkeeping is not worth it below this size. */
export const WINDOW_MIN_TURNS = 30;
/** The newest turns stay mounted: they stream, ask and change most often. */
export const WINDOW_TAIL = 2;
const DEFAULT_TURN_HEIGHT = 360;

export interface TurnBox {
  top: number;
  bottom: number;
}

/** Mounted turns, identified by key so that prepended history pages and
 * removed turns do not shift the window onto different turns. */
export interface TurnWindowRange {
  startKey: string;
  endKey: string;
  span: number;
}

/**
 * Indices of turns intersecting the viewport plus overscan. Boxes are in
 * viewport coordinates and ordered, so two binary searches find the range.
 */
export function visibleTurnRange(
  count: number,
  box: (index: number) => TurnBox,
  viewTop: number,
  viewBottom: number,
  overscan: number,
): { start: number; end: number } | null {
  if (count <= 0) return null;
  const low = viewTop - overscan;
  const high = viewBottom + overscan;
  let start = 0;
  let end = count;
  while (start < end) {
    const middle = (start + end) >> 1;
    if (box(middle).bottom > low) end = middle;
    else start = middle + 1;
  }
  start = Math.min(start, count - 1);
  let first = start;
  let last = count;
  while (first < last) {
    const middle = (first + last) >> 1;
    if (box(middle).top < high) first = middle + 1;
    else last = middle;
  }
  return { start, end: Math.max(start, first - 1) };
}

/** Resolve a key range against the current turn order. One missing edge (a
 * page that began mid-turn changes the first turn's key) keeps the span. */
export function resolveTurnRange(keys: readonly string[], range: TurnWindowRange | null): { start: number; end: number } | null {
  if (!range) return null;
  const start = keys.indexOf(range.startKey);
  const end = keys.indexOf(range.endKey);
  if (start >= 0 && end >= 0) return { start, end };
  if (end >= 0) return { start: Math.max(0, end - range.span), end };
  if (start >= 0) return { start, end: Math.min(keys.length - 1, start + range.span) };
  return null;
}

/** Before the first measurement (or after both range edges disappeared) every
 * turn stays mounted for one frame, so an anchor being restored still exists. */
export function isTurnMounted(index: number, count: number, range: { start: number; end: number } | null): boolean {
  if (!range || index >= count - WINDOW_TAIL) return true;
  return index >= range.start && index <= range.end;
}

/** Placeholder height for a turn that was never measured. */
export function estimateTurnHeight(measured: Iterable<number>): number {
  let total = 0;
  let count = 0;
  for (const height of measured) {
    total += height;
    count += 1;
  }
  return count ? Math.round(total / count) : DEFAULT_TURN_HEIGHT;
}

/**
 * Scroll adjustment that keeps the visible content still when a turn changes
 * height. A turn replacing its placeholder shifts the view when it starts
 * above the viewport; a mounted turn only when it was entirely above it, so
 * expanding a fold the reader is looking at never moves that fold.
 */
export function anchorCorrection(change: {
  top: number;
  viewportTop: number;
  previousHeight: number;
  height: number;
  replacedPlaceholder: boolean;
}): number {
  const delta = change.height - change.previousHeight;
  if (!delta) return 0;
  const above = change.replacedPlaceholder
    ? change.top < change.viewportTop
    : change.top + change.previousHeight <= change.viewportTop;
  return above ? delta : 0;
}
