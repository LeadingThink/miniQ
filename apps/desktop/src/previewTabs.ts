import type { LocalFileTarget } from "./localFiles";

export interface PreviewTabsState {
  targets: LocalFileTarget[];
  active: string | null;
  open: boolean;
  closed: Array<{ target: LocalFileTarget; index: number }>;
}
export const EMPTY_PREVIEW_TABS: PreviewTabsState = {
  targets: [],
  active: null,
  open: false,
  closed: [],
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
  const canonicalExists = state.targets.some(
    (item) => item.path === target.path,
  );
  const targets = state.targets.flatMap((item) => {
    if (item.path === target.path) return [target];
    if (item.path !== previousPath) return [item];
    return canonicalExists ? [] : [target];
  });
  return {
    targets: targets.some((item) => item.path === target.path)
      ? targets
      : [...targets, target],
    active: target.path,
    open: true,
    closed: state.closed.filter(
      ({ target: item }) =>
        item.path !== target.path && item.path !== previousPath,
    ),
  };
}

export function removePreviewTab(
  state: PreviewTabsState,
  path: string,
): PreviewTabsState {
  return closePreviewTabs(state, new Set([path]));
}

/** Retain identities and lightweight view state, never file payloads. */
export function closePreviewTabs(
  state: PreviewTabsState,
  paths: ReadonlySet<string>,
): PreviewTabsState {
  const removed = state.targets.flatMap((target, index) =>
    paths.has(target.path) ? [{ target, index }] : [],
  );
  if (!removed.length) return state;
  const targets = state.targets.filter((item) => !paths.has(item.path));
  const activeIndex = state.targets.findIndex(
    (item) => item.path === state.active,
  );
  const adjacent =
    state.targets
      .slice(activeIndex + 1)
      .find((item) => !paths.has(item.path)) ??
    state.targets
      .slice(0, activeIndex)
      .reverse()
      .find((item) => !paths.has(item.path));
  const active = paths.has(state.active ?? "")
    ? (adjacent?.path ?? null)
    : state.active;
  // The visible file reopens first after “close all”. Original positions survive.
  removed.sort(
    (a, b) =>
      Number(a.target.path === state.active) -
      Number(b.target.path === state.active),
  );
  const history = removed.map(({ target, index }, position) => ({
    target,
    // Record the position at each individual removal so undoing the batch
    // restores the original order even when the active file closed last.
    index:
      index -
      (target.path === state.active
        ? removed.filter((item) => item.index < index).length
        : position),
  }));
  return {
    targets,
    active,
    open: active !== null && state.open,
    closed: [
      ...state.closed.filter(({ target }) => !paths.has(target.path)),
      ...history,
    ],
  };
}

export function reopenPreviewTab(state: PreviewTabsState): PreviewTabsState {
  const last = state.closed.at(-1);
  if (!last) return state;
  const targets = state.targets.filter(
    (item) => item.path !== last.target.path,
  );
  targets.splice(Math.min(last.index, targets.length), 0, last.target);
  return {
    targets,
    active: last.target.path,
    open: true,
    closed: state.closed.slice(0, -1),
  };
}
