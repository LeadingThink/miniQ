import type { LocalFileTarget } from "./localFiles";

export interface PreviewTabsState {
  targets: LocalFileTarget[];
  active: string | null;
  open: boolean;
}
export const EMPTY_PREVIEW_TABS: PreviewTabsState = {
  targets: [],
  active: null,
  open: false,
};

export function selectPreviewTab(
  state: PreviewTabsState,
  target: LocalFileTarget,
  previousPath = target.path,
): PreviewTabsState {
  const targets = state.targets.filter((item) => item.path !== previousPath || previousPath === target.path);
  const index = targets.findIndex((item) => item.path === target.path);
  return {
    targets: index < 0 ? [...targets, target] : targets.map((item, i) => (i === index ? target : item)),
    active: target.path,
    open: true,
  };
}

export function removePreviewTab(state: PreviewTabsState, path: string): PreviewTabsState {
  const index = state.targets.findIndex((item) => item.path === path);
  if (index < 0) return state;
  const targets = state.targets.filter((item) => item.path !== path);
  const active = state.active === path ? (targets[Math.min(index, targets.length - 1)]?.path ?? null) : state.active;
  return { targets, active, open: active !== null && state.open };
}
