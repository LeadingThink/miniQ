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

/** Show the shortest distinguishing parent path for same-name files. */
export function previewTabDirectories(
  targets: LocalFileTarget[],
): Map<string, string> {
  const groups = new Map<string, Array<{ path: string; parents: string[] }>>();
  for (const { path } of targets) {
    const parents = path.split(/[\\/]/);
    const name = parents.pop() ?? "";
    const group = groups.get(name) ?? [];
    group.push({ path, parents });
    groups.set(name, group);
  }
  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const depth = Math.max(...group.map((entry) => entry.parents.length));
    for (let size = 1; size <= depth; size++) {
      const suffixes = group.map(
        (entry) => entry.parents.slice(-size).join("/") || "/",
      );
      const counts = new Map<string, number>();
      suffixes.forEach((suffix) =>
        counts.set(suffix, (counts.get(suffix) ?? 0) + 1),
      );
      group.forEach((entry, index) => {
        if (
          !labels.has(entry.path) &&
          (counts.get(suffixes[index]) === 1 || size === depth)
        ) {
          labels.set(entry.path, suffixes[index]);
        }
      });
    }
  }
  return labels;
}

export function selectPreviewTab(
  state: PreviewTabsState,
  target: LocalFileTarget,
  previousPath = target.path,
): PreviewTabsState {
  const targets = state.targets.filter(
    (item) => item.path !== previousPath || previousPath === target.path,
  );
  const index = targets.findIndex((item) => item.path === target.path);
  return {
    targets:
      index < 0
        ? [...targets, target]
        : targets.map((item, i) => (i === index ? target : item)),
    active: target.path,
    open: true,
  };
}

export function removePreviewTab(
  state: PreviewTabsState,
  path: string,
): PreviewTabsState {
  const index = state.targets.findIndex((item) => item.path === path);
  if (index < 0) return state;
  const targets = state.targets.filter((item) => item.path !== path);
  const active =
    state.active === path
      ? (targets[Math.min(index, targets.length - 1)]?.path ?? null)
      : state.active;
  return { targets, active, open: active !== null && state.open };
}
