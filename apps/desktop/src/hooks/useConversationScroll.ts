import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface ConversationScrollOptions {
  viewKey: string;
  /** The actual history cursor, serialized when it is an object. */
  cursorKey: string | null;
  /** Allow automatic pagination when the reader scrolls near the top. */
  autoLoadOlder: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  loading?: boolean;
  loadOlder?: () => void | Promise<void>;
  /** Change identity whenever rendered timeline content changes. */
  contentVersion: unknown;
}

interface ViewportAnchor {
  id: string;
  offset: number;
}

interface HistoryRequest {
  viewKey: string;
  cursorKey: string | null;
  anchor: ViewportAnchor | null;
}

function viewportAnchor(root: HTMLDivElement): ViewportAnchor | null {
  const bounds = root.getBoundingClientRect();
  for (const item of root.querySelectorAll<HTMLElement>("[data-history-anchor]")) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { id: item.dataset.historyAnchor!, offset: rect.top - bounds.top };
    }
  }
  return null;
}

function restoreAnchor(root: HTMLDivElement, anchor: ViewportAnchor | null) {
  if (!anchor) return;
  // Attribute comparison avoids interpolating arbitrary message ids in CSS.
  const item = Array.from(
    root.querySelectorAll<HTMLElement>("[data-history-anchor]"),
  ).find((candidate) => candidate.dataset.historyAnchor === anchor.id);
  if (item) {
    root.scrollTop +=
      item.getBoundingClientRect().top -
      root.getBoundingClientRect().top -
      anchor.offset;
  }
}

function nearBottom(root: HTMLDivElement) {
  return root.scrollHeight - root.scrollTop - root.clientHeight < 120;
}

export function useConversationScroll(options: ConversationScrollOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyTopRef = useRef<HTMLDivElement>(null);
  const latest = useRef(options);
  latest.current = options;
  const view = useRef(options.viewKey);
  const pinned = useRef(true);
  const request = useRef<HistoryRequest | null>(null);
  const inFlight = useRef<HistoryRequest | null>(null);
  const attemptedCursors = useRef(new Set<string | null>());
  const [showJump, setShowJump] = useState(false);

  const requestOlder = useCallback((automatic: boolean) => {
    const current = latest.current;
    // Check the current policy here as well as when attaching observers: a
    // queued scroll/intersection callback may outlive a connection-mode change.
    if (automatic && (!current.autoLoadOlder || pinned.current)) return;
    if (
      !current.hasOlder || current.loading ||
      current.loadingOlder || !current.loadOlder
    ) return;
    if (inFlight.current) return;
    if (automatic && attemptedCursors.current.has(current.cursorKey)) return;
    attemptedCursors.current.add(current.cursorKey);
    const pending: HistoryRequest = {
      viewKey: current.viewKey,
      cursorKey: current.cursorKey,
      anchor: scrollRef.current ? viewportAnchor(scrollRef.current) : null,
    };
    request.current = pending;
    inFlight.current = pending;
    pinned.current = false;
    setShowJump(true);
    const settle = () => {
      if (inFlight.current === pending) inFlight.current = null;
    };
    // Keep the anchor after settlement: the page can commit on the next render.
    // The caller owns error reporting; failed cursors only retry manually.
    try {
      void Promise.resolve(current.loadOlder()).then(settle, settle);
    } catch {
      settle();
    }
  }, []);

  const onScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    pinned.current = nearBottom(root);
    setShowJump(!pinned.current);
    if (request.current?.viewKey === latest.current.viewKey) {
      request.current.anchor = pinned.current ? null : viewportAnchor(root);
    }
    if (root.scrollTop <= 320) requestOlder(true);
  }, [requestOlder]);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (view.current !== options.viewKey) {
      view.current = options.viewKey;
      request.current = null;
      inFlight.current = null;
      attemptedCursors.current.clear();
      pinned.current = true;
      setShowJump(false);
    }
    if (!root) return;
    const pending = request.current;
    if (pending && (pending.cursorKey !== options.cursorKey || !options.hasOlder)) {
      if (pinned.current) root.scrollTop = root.scrollHeight;
      else restoreAnchor(root, pending.anchor);
      request.current = null;
      pinned.current = nearBottom(root);
      setShowJump(!pinned.current);
    } else if (pinned.current) {
      root.scrollTop = root.scrollHeight;
    }
  }, [
    options.viewKey, options.cursorKey, options.hasOlder,
    options.loading, options.contentVersion,
  ]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let active = true;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!active || !pinned.current || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        // Fonts, images and viewport resizing can settle after React renders.
        // Recheck pinning because the reader may have scrolled in the meantime.
        if (active && pinned.current) root.scrollTop = root.scrollHeight;
      });
    });
    observer.observe(root);
    const content = root.querySelector(".timeline-inner");
    if (content) observer.observe(content);
    return () => {
      active = false;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [options.viewKey]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = historyTopRef.current;
    if (
      !root || !sentinel || !options.hasOlder || !options.autoLoadOlder ||
      typeof IntersectionObserver === "undefined"
    ) return;
    let active = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (active && entry?.isIntersecting) requestOlder(true);
    }, { root, rootMargin: "320px 0px 0px", threshold: 0 });
    observer.observe(sentinel);
    return () => { active = false; observer.disconnect(); };
  }, [
    options.viewKey, options.cursorKey, options.hasOlder, options.autoLoadOlder,
    options.loading, options.loadingOlder, requestOlder,
  ]);

  const jumpToBottom = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    // An explicit jump supersedes a page anchor, even while it is in flight.
    if (request.current) request.current.anchor = null;
    root.scrollTop = root.scrollHeight;
    pinned.current = true;
    setShowJump(false);
  }, []);
  const loadOlder = useCallback(() => requestOlder(false), [requestOlder]);
  /** Scroll an element to the upper third and stop following new output. */
  const reveal = useCallback((element: HTMLElement) => {
    const root = scrollRef.current;
    if (!root) return;
    pinned.current = false;
    if (request.current) request.current.anchor = null;
    const offset = element.getBoundingClientRect().top - root.getBoundingClientRect().top;
    root.scrollTop = Math.max(0, root.scrollTop + offset - root.clientHeight / 3);
    setShowJump(true);
  }, []);

  return { scrollRef, historyTopRef, onScroll, loadOlder, jumpToBottom, showJump, reveal };
}
