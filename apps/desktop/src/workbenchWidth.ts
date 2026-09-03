export const DEFAULT_WORKBENCH_WIDTH = 560;
export const MIN_WORKBENCH_WIDTH = 380;
export const MAX_WORKBENCH_WIDTH = 900;
export const WORKBENCH_WIDTH_STORAGE_KEY = "miniq.workbench.width";

export function maxWorkbenchWidth(viewportWidth: number, sidebarCollapsed: boolean): number {
  const reservedWidth = sidebarCollapsed ? 440 : 704;
  return Math.max(
    MIN_WORKBENCH_WIDTH,
    Math.min(MAX_WORKBENCH_WIDTH, viewportWidth - reservedWidth),
  );
}

export function clampWorkbenchWidth(
  width: number,
  viewportWidth: number,
  sidebarCollapsed: boolean,
): number {
  const value = Number.isFinite(width) ? width : DEFAULT_WORKBENCH_WIDTH;
  return Math.round(
    Math.min(
      Math.max(value, MIN_WORKBENCH_WIDTH),
      maxWorkbenchWidth(viewportWidth, sidebarCollapsed),
    ),
  );
}

export function readWorkbenchWidth(
  storage: Pick<Storage, "getItem">,
  viewportWidth: number,
  sidebarCollapsed: boolean,
): number {
  const stored = Number(storage.getItem(WORKBENCH_WIDTH_STORAGE_KEY));
  return clampWorkbenchWidth(stored || DEFAULT_WORKBENCH_WIDTH, viewportWidth, sidebarCollapsed);
}
