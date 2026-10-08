import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TimelineGroup } from "../timelineModel";
import { findHitElement, paintSearchHighlights, searchHits, type SearchHit } from "../sessionSearch";

interface SearchNavigationOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  groups: TimelineGroup[];
  /** True while the timeline shows search or filter results. */
  enabled: boolean;
  /** Changes whenever the search query or filter changes. */
  searchKey: string;
  query: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  reveal: (element: HTMLElement) => void;
  contentVersion: unknown;
}

/**
 * Step through search results like find-in-page. The newest hit is current
 * first. Stepping past the oldest loaded hit loads the next result page.
 */
export function useSearchNavigation(options: SearchNavigationOptions) {
  const { scrollRef, enabled, query, hasOlder, loadingOlder, loadOlder, reveal } = options;
  const hits = useMemo(() => (enabled ? searchHits(options.groups) : []), [enabled, options.groups]);
  const [selected, setSelected] = useState<string | null>(null);
  const [olderFrom, setOlderFrom] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState(0);
  const sawLoading = useRef(false);
  const found = selected ? hits.findIndex((hit) => hit.key === selected) : -1;
  const index = found >= 0 ? found : hits.length - 1;
  const current: SearchHit | null = hits[index] ?? null;

  useEffect(() => {
    setSelected(null);
    setOlderFrom(null);
  }, [options.searchKey]);

  const select = useCallback((hit: SearchHit) => {
    setSelected(hit.key);
    setScrollRequest((value) => value + 1);
  }, []);

  /** -1 moves to an older hit; 1 moves to a newer hit. */
  const step = useCallback((direction: -1 | 1) => {
    if (!current || olderFrom) return;
    const next = index + direction;
    if (next < 0) {
      if (hasOlder) {
        sawLoading.current = false;
        setOlderFrom(current.key);
        loadOlder();
      } else select(hits[hits.length - 1]);
      return;
    }
    select(hits[next >= hits.length ? 0 : next]);
  }, [current, olderFrom, index, hasOlder, loadOlder, select, hits]);

  // Finish a step that had to load an older result page first.
  useEffect(() => {
    if (!olderFrom) return;
    if (loadingOlder) sawLoading.current = true;
    const at = hits.findIndex((hit) => hit.key === olderFrom);
    if (at > 0) {
      setOlderFrom(null);
      select(hits[at - 1]);
    } else if (!loadingOlder && (sawLoading.current || !hasOlder)) {
      setOlderFrom(null);
    }
  }, [olderFrom, hits, loadingOlder, hasOlder, select]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!scrollRequest || !root || !current) return;
    const element = findHitElement(root, current);
    if (element) reveal(element);
    // Scroll only for explicit steps, not for every content update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!enabled || !root) return;
    const element = current ? findHitElement(root, current) : null;
    element?.setAttribute("data-search-current", "true");
    const clear = query.trim() ? paintSearchHighlights(root, query, element) : () => undefined;
    return () => {
      element?.removeAttribute("data-search-current");
      clear();
    };
  }, [enabled, query, current, scrollRef, options.contentVersion]);

  return {
    count: hits.length,
    position: current ? index + 1 : 0,
    current,
    loadingMore: Boolean(olderFrom),
    step,
  };
}
