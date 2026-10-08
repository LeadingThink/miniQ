import type { TimelineGroup } from "./timelineModel";

/** One search result: a rendered timeline record that can be scrolled to. */
export interface SearchHit {
  key: string;
  kind: "message" | "artifact" | "tool";
  id: string;
}

export function searchHits(groups: TimelineGroup[]): SearchHit[] {
  return groups.map((group): SearchHit => {
    if (group.kind === "message")
      return { key: `message:${group.message.id}`, kind: "message", id: group.message.id };
    if (group.kind === "artifact")
      return { key: `artifact:${group.artifact.id}`, kind: "artifact", id: group.artifact.id };
    return { key: `tool:${group.calls[0].id}`, kind: "tool", id: group.calls[0].id };
  });
}

/**
 * Find the element that shows a hit. Folded execution summaries and tool
 * groups list their hidden records in `data-search-records`. Attribute
 * comparison avoids interpolating arbitrary ids in CSS selectors.
 */
export function findHitElement(root: ParentNode, hit: SearchHit): HTMLElement | null {
  const anchored = Array.from(root.querySelectorAll<HTMLElement>("[data-history-anchor]"))
    .find((element) => element.dataset.historyAnchor === hit.key);
  if (anchored) return anchored;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-search-records]"))
    .find((element) => element.dataset.searchRecords!.split(" ").includes(hit.key)) ?? null;
}

const MAX_HIGHLIGHTS = 2000;
export const SEARCH_HIGHLIGHT = "miniq-session-search";
export const SEARCH_HIGHLIGHT_CURRENT = "miniq-session-search-current";

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function highlightApi() {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

/** Text ranges in `root` that contain `query`, case-insensitively. */
export function matchRanges(root: Node, query: string, limit = MAX_HIGHLIGHTS): Range[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  const document = root.ownerDocument ?? (root as Document);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("textarea, script, style, [data-search-ignore]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node && ranges.length < limit; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").toLocaleLowerCase();
    // Lowercasing can change length for a few scripts; skip those nodes.
    if (text.length !== (node.nodeValue ?? "").length) continue;
    for (let at = text.indexOf(needle); at >= 0 && ranges.length < limit; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * Paint matches with the CSS Custom Highlight API. It does not mutate the
 * React-owned DOM. Older WebViews without the API keep counting and stepping.
 */
export function paintSearchHighlights(root: HTMLElement, query: string, current: HTMLElement | null) {
  const api = highlightApi();
  if (!api) return () => undefined;
  const ranges = matchRanges(root, query);
  const inCurrent = current ? ranges.filter((range) => current.contains(range.startContainer)) : [];
  api.registry.set(SEARCH_HIGHLIGHT, new api.Highlight(...ranges.filter((range) => !inCurrent.includes(range))));
  api.registry.set(SEARCH_HIGHLIGHT_CURRENT, new api.Highlight(...inCurrent));
  return () => {
    api.registry.delete(SEARCH_HIGHLIGHT);
    api.registry.delete(SEARCH_HIGHLIGHT_CURRENT);
  };
}
