import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import "./VirtualList.css";

export interface VirtualListHandle {
  scrollToIndex: (index: number) => void;
}

interface Props {
  count: number;
  getKey: (index: number) => string;
  estimateSize: (index: number) => number;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The shared content moves this list when an earlier project is expanded. */
  contentRef?: RefObject<HTMLDivElement | null>;
  keepMounted?: readonly number[];
  handle?: Ref<VirtualListHandle>;
  children: (index: number) => ReactNode;
}

const EMPTY_INDICES: readonly number[] = [];

/** Window rows using measured heights; all data remains available to navigation.
 * The mutable virtualizer must be read on every render, without compiler caching. */
export function VirtualList({
  count,
  getKey,
  estimateSize,
  scrollRef,
  contentRef,
  keepMounted = EMPTY_INDICES,
  handle,
  children,
}: Props) {
  "use no memo";
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const enabled = count > 80;
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) =>
      [
        ...new Set([
          ...defaultRangeExtractor(range),
          ...keepMounted.filter((index) => index >= 0 && index < count),
        ]),
      ].sort((a, b) => a - b),
    [count, keepMounted],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getItemKey: getKey,
    estimateSize,
    enabled,
    scrollMargin,
    rangeExtractor,
    getScrollElement: () => scrollRef.current,
    overscan: 8,
    initialRect: { width: 0, height: 480 },
  });
  useLayoutEffect(() => {
    if (!enabled) return;
    const scroll = scrollRef.current,
      list = listRef.current;
    if (!scroll || !list) return;
    let width = scroll.clientWidth;
    const measure = () => {
      setScrollMargin(
        list.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          scroll.clientTop +
          scroll.scrollTop,
      );
      if (width !== scroll.clientWidth) {
        width = scroll.clientWidth;
        virtualizer.measure();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    observer.observe(contentRef?.current ?? list);
    return () => observer.disconnect();
  }, [enabled, scrollRef, contentRef, virtualizer]);
  useImperativeHandle(
    handle,
    () => ({
      scrollToIndex(index) {
        if (index < 0 || index >= count) return;
        if (enabled) virtualizer.scrollToIndex(index, { align: "auto" });
        else
          listRef.current?.children[index]?.scrollIntoView?.({
            block: "nearest",
          });
      },
    }),
    [count, enabled, virtualizer],
  );
  const rows = enabled
    ? virtualizer.getVirtualItems()
    : Array.from({ length: count }, (_, index) => ({
        index,
        key: getKey(index),
        start: 0,
      }));
  return (
    <div
      ref={listRef}
      className="virtual-list"
      data-virtualized={enabled || undefined}
      style={enabled ? { height: virtualizer.getTotalSize() } : undefined}
    >
      {rows.map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          className="virtual-list-row"
          ref={enabled ? virtualizer.measureElement : undefined}
          style={
            enabled
              ? {
                  position: "absolute",
                  top: row.start - scrollMargin,
                  left: 0,
                  width: "100%",
                }
              : undefined
          }
        >
          {children(row.index)}
        </div>
      ))}
    </div>
  );
}
