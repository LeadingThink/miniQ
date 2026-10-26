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
  loadOlder?: () => void | { error: unknown } | Promise<void | { error: unknown }>;
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

function historyErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error ?? "Unable to load older history");
}

/** Retry transport failures and temporary server errors, never invalid requests. */
export function isRetryableHistoryError(error: unknown): boolean {
  const details = error && typeof error === "object"
    ? error as { name?: string; status?: number; statusCode?: number; code?: string | number }
    : {};
  const code = Number(details.code ?? (typeof error === "number" ? error : NaN));
  // JSON-RPC parse, request, method and parameter errors cannot recover by retrying.
  if ([-32700, -32600, -32601, -32602].includes(code)) return false;
  const message = `${details.code ?? ""} ${historyErrorMessage(error)}`;
  if (details.name === "AbortError" || /abort|unauthori[sz]ed|forbidden|auth|invalid|bad request|not found|permission|access denied|\b(?:400|401|403|404|422)\b/i.test(message)) return false;
  const status = Number(details.status ?? details.statusCode ?? code);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  return status === 408 || status === 429 || (status >= 500 && status < 600) ||
    /network|fetch failed|failed to fetch|timeout|timed out|temporar|unavailable|disconnect|connection|offline|econn|enet|ehost|rate.?limit|\b(?:408|429|5\d\d)\b/i.test(message);
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
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [retryingOlder, setRetryingOlder] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTask = useRef<{ run: () => void; remaining: number; due: number } | null>(null);
  const offline = useRef(typeof navigator !== "undefined" && !navigator.onLine);
  const exhausted = useRef<HistoryRequest | null>(null);
  const shortPage = useRef(false);
  const cancelRetry = useCallback(() => {
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    retryTask.current = null;
  }, []);
  const resumeRetry = useCallback(() => {
    const task = retryTask.current;
    if (!task || offline.current || retryTimer.current !== null) return;
    task.due = Date.now() + task.remaining;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      retryTask.current = null;
      task.run();
    }, task.remaining);
  }, []);
  // null until the first layout, which always lands at the bottom.
  const loadingState = useRef<boolean | undefined | null>(null);
  // Following new output scrolls at most once per frame, however many
  // streamed updates or resizes arrive within it.
  const followFrame = useRef<number | null>(null);
  const cancelFollow = useCallback(() => {
    if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
    followFrame.current = null;
  }, []);
  const follow = useCallback(() => {
    if (followFrame.current !== null) return;
    followFrame.current = requestAnimationFrame(() => {
      followFrame.current = null;
      const root = scrollRef.current;
      // Recheck pinning because the reader may have scrolled in the meantime.
      if (root && pinned.current) root.scrollTop = root.scrollHeight;
    });
  }, []);
  // An explicit jump keeps landing on the bottom while late layout (windowed
  // turns, images, fonts) still grows the transcript, until the reader acts.
  const settleFrame = useRef<number | null>(null);
  const cancelSettle = useCallback(() => {
    if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    settleFrame.current = null;
  }, []);
  const settleAtBottom = useCallback(() => {
    cancelSettle();
    let height = -1;
    let stableFrames = 0;
    let remaining = 60;
    const step = () => {
      settleFrame.current = null;
      const root = scrollRef.current;
      if (!root || !pinned.current) return;
      root.scrollTop = root.scrollHeight;
      stableFrames = root.scrollHeight === height ? stableFrames + 1 : 0;
      height = root.scrollHeight;
      if (stableFrames < 2 && --remaining > 0) settleFrame.current = requestAnimationFrame(step);
    };
    step();
  }, [cancelSettle]);

  const requestOlder = useCallback((automatic: boolean, intentional = false) => {
    const current = latest.current;
    // Check the current policy here as well as when attaching observers: a
    // queued scroll/intersection callback may outlive a connection-mode change.
    if (automatic && (!current.autoLoadOlder || (!intentional && (pinned.current || shortPage.current)))) return;
    if (
      offline.current || !current.hasOlder || current.loading ||
      current.loadingOlder || !current.loadOlder
    ) return;
    if (!automatic && retryTimer.current !== null) {
      cancelRetry();
      inFlight.current = null;
    }
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
    exhausted.current = null;
    shortPage.current = !!scrollRef.current && nearBottom(scrollRef.current);
    pinned.current = false;
    setShowJump(true);
    setHistoryError(null);
    setRetryingOlder(false);
    let retries = 0;
    const active = () => inFlight.current === pending && latest.current.viewKey === pending.viewKey;
    const finish = () => {
      inFlight.current = null;
      setRetryingOlder(false);
    };
    const fail = (error: unknown) => {
      if (!active()) return;
      if (latest.current.cursorKey !== pending.cursorKey || !latest.current.hasOlder) {
        finish();
        return;
      }
      setHistoryError(historyErrorMessage(error));
      if (!isRetryableHistoryError(error) || retries === 3) {
        exhausted.current = isRetryableHistoryError(error) ? pending : null;
        finish();
        return;
      }
      setRetryingOlder(true);
      retryTask.current = { remaining: 1000 * 2 ** retries, due: 0, run: () => {
        if (!active()) return;
        if (latest.current.cursorKey !== pending.cursorKey || !latest.current.hasOlder) {
          finish();
          return;
        }
        retries++;
        run();
      } };
      resumeRetry();
    };
    const run = () => {
      try {
        void Promise.resolve(latest.current.loadOlder?.()).then((result) => {
          if (!active()) return;
          if (result && "error" in result) { fail(result.error); return; }
          setHistoryError(null);
          // Keep the anchor: the successful page can commit on the next render.
          finish();
        }, fail);
      } catch (error) { fail(error); }
    };
    run();
  }, [cancelRetry, resumeRetry]);

  const onScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    pinned.current = nearBottom(root) || settleFrame.current !== null;
    setShowJump(!pinned.current);
    if (request.current?.viewKey === latest.current.viewKey) {
      request.current.anchor = pinned.current ? null : viewportAnchor(root);
    }
    if (root.scrollTop <= 320) requestOlder(true);
  }, [requestOlder]);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    // Opening a view or finishing its load lands at the bottom before paint.
    let immediate = loadingState.current !== options.loading;
    loadingState.current = options.loading;
    if (view.current !== options.viewKey) {
      immediate = true;
      cancelFollow();
      cancelSettle();
      cancelRetry();
      exhausted.current = null;
      view.current = options.viewKey;
      request.current = null;
      inFlight.current = null;
      attemptedCursors.current.clear();
      shortPage.current = false;
      setHistoryError(null);
      setRetryingOlder(false);
      pinned.current = true;
      setShowJump(false);
    }
    if (!root) return;
    const pending = request.current;
    if (pending && (pending.cursorKey !== options.cursorKey || !options.hasOlder)) {
      if (retryTask.current !== null) {
        cancelRetry();
        inFlight.current = null;
        setRetryingOlder(false);
      }
      setHistoryError(null);
      exhausted.current = null;
      if (pinned.current) root.scrollTop = root.scrollHeight;
      else restoreAnchor(root, pending.anchor);
      request.current = null;
      pinned.current = nearBottom(root);
      setShowJump(!pinned.current);
    } else if (pinned.current && immediate) {
      cancelFollow();
      root.scrollTop = root.scrollHeight;
    } else if (pinned.current) {
      follow();
    }
  }, [
    options.viewKey, options.cursorKey, options.hasOlder,
    options.loading, options.contentVersion,
  ]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let active = true;
    // Fonts, images and viewport resizing can settle after React renders.
    const observer = new ResizeObserver(() => {
      if (active && pinned.current) follow();
    });
    observer.observe(root);
    const content = root.querySelector(".timeline-inner");
    if (content) observer.observe(content);
    return () => {
      active = false;
      observer.disconnect();
      cancelFollow();
    };
  }, [options.viewKey, follow, cancelFollow]);

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

  useEffect(() => () => {
    cancelRetry();
    cancelFollow();
    cancelSettle();
    inFlight.current = null;
    request.current = null;
    exhausted.current = null;
  }, [cancelRetry, cancelFollow, cancelSettle]);

  useEffect(() => {
    const pause = () => {
      offline.current = true;
      if (retryTimer.current !== null) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
        if (retryTask.current) retryTask.current.remaining = Math.max(0, retryTask.current.due - Date.now());
      }
    };
    const reconnect = () => {
      offline.current = false;
      resumeRetry();
      const failed = exhausted.current;
      const current = latest.current;
      const root = scrollRef.current;
      if (!failed || failed.viewKey !== current.viewKey || failed.cursorKey !== current.cursorKey ||
        !root || root.scrollTop > 320 || !current.autoLoadOlder || !current.hasOlder ||
        current.loading || current.loadingOlder || !current.loadOlder || inFlight.current) return;
      attemptedCursors.current.delete(current.cursorKey);
      requestOlder(true, true);
    };
    window.addEventListener("offline", pause);
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("offline", pause);
      window.removeEventListener("online", reconnect);
    };
  }, [requestOlder, resumeRetry]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const navigateUp = () => {
      if (root.scrollTop > 320) return;
      requestOlder(true, true);
    };
    const wheel = (event: WheelEvent) => {
      cancelSettle();
      if (event.deltaY < 0) navigateUp();
    };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent) => {
      cancelSettle();
      touchY = event.touches[0]?.clientY ?? null;
    };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && y > touchY) {
        touchY = null;
        navigateUp();
      }
    };
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      cancelSettle();
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) navigateUp();
    };
    root.addEventListener("wheel", wheel, { passive: true });
    root.addEventListener("touchstart", touchStart, { passive: true });
    root.addEventListener("touchmove", touchMove, { passive: true });
    root.addEventListener("keydown", key);
    // Dragging the scrollbar is also the reader taking over.
    root.addEventListener("pointerdown", cancelSettle);
    return () => {
      root.removeEventListener("wheel", wheel);
      root.removeEventListener("touchstart", touchStart);
      root.removeEventListener("touchmove", touchMove);
      root.removeEventListener("keydown", key);
      root.removeEventListener("pointerdown", cancelSettle);
    };
  }, [options.viewKey, requestOlder, cancelSettle]);

  const jumpToBottom = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    // An explicit jump supersedes a page anchor, even while it is in flight.
    if (request.current) request.current.anchor = null;
    cancelFollow();
    pinned.current = true;
    settleAtBottom();
    setShowJump(false);
  }, [cancelFollow, settleAtBottom]);
  const loadOlder = useCallback(() => requestOlder(false), [requestOlder]);
  /** Scroll an element to the upper third and stop following new output. */
  const reveal = useCallback((element: HTMLElement) => {
    const root = scrollRef.current;
    if (!root) return;
    // A settled turn retains its records inside a native disclosure. Reveal
    // ancestors before measuring, otherwise search scrolls to a hidden zero rect.
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    pinned.current = false;
    cancelFollow();
    cancelSettle();
    if (request.current) request.current.anchor = null;
    const offset = element.getBoundingClientRect().top - root.getBoundingClientRect().top;
    root.scrollTop = Math.max(0, root.scrollTop + offset - root.clientHeight / 3);
    setShowJump(true);
  }, [cancelFollow, cancelSettle]);

  return { scrollRef, historyTopRef, onScroll, loadOlder, jumpToBottom, showJump, reveal, historyError, retryingOlder };
}
