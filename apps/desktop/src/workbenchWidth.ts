export const DEFAULT_WORKBENCH_WIDTH = 560;
export const MIN_WORKBENCH_WIDTH = 320;
export const WORKBENCH_WIDTH_STORAGE_KEY = "miniq.workbench.width";

export function workbenchLayout(availableWidth: number, viewportWidth: number) {
  // Leave 320px for the conversation and up to 30px for inter-panel margins.
  const mobile = viewportWidth <= 720;
  const split = !mobile && availableWidth >= MIN_WORKBENCH_WIDTH + 350;
  const max = Math.max(0, split ? availableWidth - 350 : viewportWidth - 24);
  return {
    mode: mobile ? "mobile" : split ? "split" : "overlay",
    min: Math.min(MIN_WORKBENCH_WIDTH, max),
    max,
  } as const;
}

export function clampWorkbenchWidth(
  width: number,
  min: number,
  max: number,
): number {
  const value = Number.isFinite(width) ? width : DEFAULT_WORKBENCH_WIDTH;
  return Math.round(Math.min(Math.max(value, min), max));
}

export function readWorkbenchWidth(storage: Pick<Storage, "getItem">): number {
  const stored = Number(storage.getItem(WORKBENCH_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0
    ? stored
    : DEFAULT_WORKBENCH_WIDTH;
}
