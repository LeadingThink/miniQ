import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Session } from "../types";
import {
  registerSidebarList,
} from "./SidebarNavigation";
import { useMobileLayout } from "../hooks/useMobileLayout";
import { SidebarSessionItem } from "./SidebarSessionItem";
import { VirtualList, type VirtualListHandle } from "./ui/VirtualList";

interface Props {
  sessions: Session[];
  currentSessionId: string | null;
  unreadSessionIds: ReadonlySet<string>;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  workspaceLabels?: ReadonlyMap<string, string>;
  onSelectSession: (sessionId: string) => void;
  onSessionSeen: (sessionId: string) => void;
  onSessionUnread?: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onDeleteSessionStart?: (sessionId: string) => void;
  onDeleteSessionUndo?: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
  onSetSessionArchived: (sessionId: string, archived: boolean) => void;
}

export function SidebarSessionList(props: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const handle = useRef<VirtualListHandle>(null);
  const mobile = useMobileLayout();
  const [interacting, setInteracting] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [focused, setFocused] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const revealed = useRef<string | null>(null);
  const currentIndex = props.sessions.findIndex(
    (session) => session.id === props.currentSessionId,
  );
  const keepMounted = props.sessions.flatMap((session, index) =>
    interacting.has(session.id) ||
    session.id === focused ||
    session.id === revealing
      ? [index]
      : [],
  );
  const onInteracting = useCallback(
    (id: string, active: boolean) =>
      setInteracting((current) => {
        if (current.has(id) === active) return current;
        const next = new Set(current);
        if (active) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  useLayoutEffect(() => {
    if (currentIndex < 0) {
      revealed.current = null;
      setRevealing(null);
      return;
    }
    if (revealed.current === props.currentSessionId) return;
    revealed.current = props.currentSessionId;
    setRevealing(props.currentSessionId);
    handle.current?.scrollToIndex(currentIndex);
  }, [currentIndex, props.currentSessionId]);
  useEffect(() => {
    const scroll = props.scrollRef.current;
    const release = () => setRevealing(null);
    scroll?.addEventListener("scroll", release, { passive: true });
    return () => scroll?.removeEventListener("scroll", release);
  }, [props.scrollRef]);
  useLayoutEffect(
    () =>
      registerSidebarList(listRef.current!, {
        count: props.sessions.length,
        focus(index) {
          const session = props.sessions[index];
          if (!session) return;
          setFocused(session.id);
          setPendingFocus(session.id);
          handle.current?.scrollToIndex(index);
        },
      }),
    [props.sessions],
  );
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    const index = props.sessions.findIndex(
      (session) => session.id === pendingFocus,
    );
    const button = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-index="${index}"] .session-select`,
    );
    if (button) {
      button.focus({ preventScroll: true });
      setPendingFocus(null);
    }
  }, [pendingFocus, props.sessions]);
  return (
    <div
      ref={listRef}
      className={
        props.workspaceLabels ? "archived-sessions" : "workspace-sessions"
      }
      data-sidebar-session-list
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-index]",
        );
        if (row)
          setFocused(props.sessions[Number(row.dataset.index)]?.id ?? null);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(null);
      }}
    >
      <VirtualList
        count={props.sessions.length}
        getKey={(index) => props.sessions[index].id}
        estimateSize={() => (mobile ? 44 : 36)}
        scrollRef={props.scrollRef}
        contentRef={props.contentRef}
        handle={handle}
        keepMounted={keepMounted}
      >
        {(index) => {
          const session = props.sessions[index];
          return (
            <SidebarSessionItem
              session={session}
              current={session.id === props.currentSessionId}
              revealCurrent={false}
              contextLabel={props.workspaceLabels?.get(session.workspaceId)}
              onInteracting={onInteracting}
              onSelect={props.onSelectSession}
              onSeen={props.onSessionSeen}
              onMarkUnread={props.onSessionUnread}
              unread={props.unreadSessionIds.has(session.id)}
              onDelete={props.onDeleteSession}
              onDeleteStart={props.onDeleteSessionStart}
              onDeleteUndo={props.onDeleteSessionUndo}
              onRename={props.onRenameSession}
              onSetPinned={props.onSetSessionPinned}
              onSetArchived={props.onSetSessionArchived}
            />
          );
        }}
      </VirtualList>
    </div>
  );
}
