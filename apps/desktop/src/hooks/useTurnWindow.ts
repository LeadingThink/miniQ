import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  anchorCorrection,
  estimateTurnHeight,
  isTurnMounted,
  resolveTurnRange,
  visibleTurnRange,
  type TurnWindowRange,
} from "../timelineWindow";

interface TurnWindowOptions {
  scrollRef?: RefObject<HTMLDivElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  keys: readonly string[];
  enabled: boolean;
}

const NO_KEYS: ReadonlySet<string> = new Set();

function turnElements(list: HTMLElement): HTMLElement[] {
  return Array.from(list.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement && Boolean(element.dataset.turnKey));
}

/**
 * Mount only turns near the viewport. Every turn keeps one wrapper element
 * (`[data-turn-key]`); unmounted turns become fixed-height placeholders using
 * their last measured height, and the scroll position is corrected when turns
 * above the viewport change height so reading never jumps.
 */
export function useTurnWindow({ scrollRef, listRef, keys, enabled }: TurnWindowOptions) {
  const measured = useRef(new Map<string, number>());
  const rendered = useRef(new Map<string, { height: number; placeholder: boolean }>());
  const [range, setRange] = useState<TurnWindowRange | null>(null);
  const [forced, setForced] = useState<ReadonlySet<string>>(NO_KEYS);
  const syncElements = useRef<() => void>(() => undefined);
  const resolved = enabled ? resolveTurnRange(keys, range) : null;

  useEffect(() => {
    const root = scrollRef?.current;
    const list = listRef.current;
    if (!enabled || !root || !list) return;
    let frame: number | null = null;
    let scrolled = false;
    const update = () => {
      frame = null;
      // A reader's scroll supersedes turns mounted only to reveal a record.
      // Clear them with the new range so the revealed turn never flickers.
      if (scrolled) setForced(NO_KEYS);
      scrolled = false;
      const elements = turnElements(list);
      for (const element of elements) {
        const key = element.dataset.turnKey!;
        if (element.dataset.windowPlaceholder === undefined && !measured.current.has(key))
          measured.current.set(key, element.getBoundingClientRect().height);
      }
      const rootTop = root.getBoundingClientRect().top;
      const visible = visibleTurnRange(elements.length, (index) => {
        const rect = elements[index].getBoundingClientRect();
        return { top: rect.top - rootTop, bottom: rect.bottom - rootTop };
      }, 0, root.clientHeight, Math.max(root.clientHeight, 600));
      if (!visible) return;
      const next = {
        startKey: elements[visible.start].dataset.turnKey!,
        endKey: elements[visible.end].dataset.turnKey!,
        span: visible.end - visible.start,
      };
      setRange((current) => current && current.startKey === next.startKey && current.endKey === next.endKey
        && current.span === next.span ? current : next);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    const onScroll = () => {
      scrolled = true;
      schedule();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      const viewportTop = root.getBoundingClientRect().top;
      let correction = 0;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const key = element.dataset.turnKey;
        if (!key) continue;
        const placeholder = element.dataset.windowPlaceholder !== undefined;
        const height = element.getBoundingClientRect().height;
        const previous = rendered.current.get(key);
        rendered.current.set(key, { height, placeholder });
        if (placeholder) continue;
        measured.current.set(key, height);
        if (previous) correction += anchorCorrection({
          top: element.getBoundingClientRect().top,
          viewportTop,
          previousHeight: previous.height,
          height,
          replacedPlaceholder: previous.placeholder,
        });
      }
      if (correction) root.scrollTop += correction;
      schedule();
    });
    observer?.observe(root);
    const observed = new Set<Element>();
    syncElements.current = () => {
      for (const element of observed) {
        if (element.isConnected) continue;
        observer?.unobserve(element);
        observed.delete(element);
      }
      for (const element of turnElements(list)) {
        if (observed.has(element)) continue;
        observer?.observe(element);
        observed.add(element);
      }
      schedule();
    };
    syncElements.current();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      syncElements.current = () => undefined;
    };
  }, [enabled, scrollRef, listRef]);

  // New, removed or remounted turn wrappers need observing after each commit.
  useLayoutEffect(() => { syncElements.current(); }, [keys, resolved?.start, resolved?.end, forced]);

  let estimate: number | undefined;
  return {
    isMounted: (index: number) => !enabled
      || isTurnMounted(index, keys.length, resolved)
      || forced.has(keys[index]),
    placeholderHeight: (key: string) =>
      measured.current.get(key) ?? (estimate ??= estimateTurnHeight(measured.current.values())),
    /** Keep a turn mounted until the reader scrolls, so a caller can find and
     * reveal content inside it after the next commit. */
    mount: (key: string) => setForced((current) => current.has(key) ? current : new Set([...current, key])),
  };
}
