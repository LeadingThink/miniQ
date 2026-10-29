import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Folder, FolderOpen, MoreHorizontal, PencilLine, Plus, Trash2 } from "lucide-react";
import type { Session, Workspace } from "../types";
import { revealInFinder } from "../fileActions";
import { DropdownMenu } from "./DropdownMenu";
import { ConfirmDialog } from "./ui/Dialog";
import { useProjectDisclosure } from "./SidebarNavigation";
import { SidebarSessionList } from "./SidebarSessionList";

const COLLAPSED_SESSION_COUNT = 3;

interface WorkspaceGroupProps {
  workspace: Workspace;
  sessions: Session[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  collapseAllVersion: number;
  unreadSessionIds: ReadonlySet<string>;
  currentSessionId: string | null;
  selected: boolean;
  filtering: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateSession: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onEditWorkspace: (workspaceId: string) => void;
  canReveal?: boolean;
  onError?: (message: string) => void;
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

export function WorkspaceGroup(props: WorkspaceGroupProps) {
  const [preferredOpen, setOpen] = useProjectDisclosure(props.workspace.id);
  const open = props.filtering || preferredOpen;
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.workspace.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);
  const hiddenCount = Math.max(0, props.sessions.length - COLLAPSED_SESSION_COUNT);
  const previousSession = useRef({ id: props.currentSessionId, revealed: false });

  useEffect(() => {
    if (previousSession.current.id !== props.currentSessionId) {
      previousSession.current = { id: props.currentSessionId, revealed: false };
    }
    if (previousSession.current.revealed) return;
    const currentIndex = props.sessions.findIndex((session) => session.id === props.currentSessionId);
    if (currentIndex < 0) return;
    previousSession.current.revealed = true;
    setOpen(true);
    if (currentIndex >= COLLAPSED_SESSION_COUNT) setExpanded(true);
  }, [props.currentSessionId, props.sessions, setOpen]);
  useEffect(() => {
    if (props.collapseAllVersion > 0) setOpen(false);
  }, [props.collapseAllVersion, setOpen]);
  const visibleSessions = !open ? [] : (expanded || props.filtering)
    ? props.sessions
    : props.sessions.slice(0, COLLAPSED_SESSION_COUNT);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const commitRename = () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (trimmed && trimmed !== props.workspace.name) {
      props.onRenameWorkspace(props.workspace.id, trimmed);
    } else {
      setRenameValue(props.workspace.name);
    }
  };

  return (
    <div className="workspace-group">
      <div className={`workspace-item ${props.selected ? "selected" : ""}`}>
        {renaming ? (
          <input
            ref={inputRef}
            className="rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              }
              if (e.key === "Escape") {
                setRenameValue(props.workspace.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="workspace-select"
            title={[props.workspace.path, ...props.workspace.additionalPaths].join("\n")}
            aria-label={props.workspace.name}
            aria-current={props.selected ? "true" : undefined}
            aria-expanded={open}
            onClick={() => {
              props.onSelectWorkspace(props.workspace.id);
              if (!props.filtering) setOpen(!open);
            }}
          >
            <ChevronRight className="workspace-disclosure" size={12} aria-hidden="true" />
            <Folder className="workspace-icon" size={15} />
            <span className="workspace-name">{props.workspace.name}</span>
            {props.workspace.additionalPaths.length > 0 && <span className="workspace-root-count">{props.workspace.additionalPaths.length + 1}</span>}
            <span className="workspace-session-count" aria-label={`${props.sessions.length} 条会话`}>{props.sessions.length}</span>
          </button>
        )}
        <button
          type="button"
          className="new-session"
          aria-label={`在 ${props.workspace.name} 中新建会话`}
          title="新建会话"
          onClick={(event) => {
            event.stopPropagation();
            props.onCreateSession(props.workspace.id);
          }}
        >
          <Plus size={15} />
        </button>
        <div className="menu-container">
          <button
            type="button"
            ref={menuBtnRef}
            className="menu-trigger"
            aria-label={`${props.workspace.name} 的更多操作`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="更多操作"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          <DropdownMenu
            triggerRef={menuBtnRef}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
          >
            <button type="button" className="dropdown-item" onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              props.onCreateSession(props.workspace.id);
            }}>
              <Plus size={13} /><span>在此项目新建会话</span>
            </button>
            <button type="button" className="dropdown-item" onClick={() => {
              setMenuOpen(false);
              props.onEditWorkspace(props.workspace.id);
            }}>
              <Folder size={13} /><span>项目目录</span>
            </button>
            {props.canReveal && (
              <button type="button" className="dropdown-item" onClick={() => {
                setMenuOpen(false);
                void revealInFinder(props.workspace.path, { directory: true }).catch((cause) =>
                  props.onError?.(cause instanceof Error ? cause.message : String(cause)),
                );
              }}>
                <FolderOpen size={13} /><span>在 Finder 中显示</span>
              </button>
            )}
            <button
              type="button"
              className="dropdown-item"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                renameCommittedRef.current = false;
                setRenameValue(props.workspace.name);
                setRenaming(true);
              }}
            >
              <PencilLine size={13} />
              <span>重命名</span>
            </button>
            <button
              type="button"
              className="dropdown-item danger"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                setConfirmDelete(true);
              }}
            >
              <Trash2 size={13} />
              <span>删除工作区</span>
            </button>
          </DropdownMenu>
        </div>
      </div>
      {visibleSessions.length > 0 && <SidebarSessionList
        sessions={visibleSessions}
        currentSessionId={props.currentSessionId}
        unreadSessionIds={props.unreadSessionIds}
        scrollRef={props.scrollRef}
        contentRef={props.contentRef}
        onSelectSession={props.onSelectSession}
        onSessionSeen={props.onSessionSeen}
        onSessionUnread={props.onSessionUnread}
        onDeleteSession={props.onDeleteSession}
        onDeleteSessionStart={props.onDeleteSessionStart}
        onDeleteSessionUndo={props.onDeleteSessionUndo}
        onRenameSession={props.onRenameSession}
        onSetSessionPinned={props.onSetSessionPinned}
        onSetSessionArchived={props.onSetSessionArchived}
      />}
      {open && !props.filtering && hiddenCount > 0 && (
        <button
          type="button"
          className="session-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <span>{expanded ? "收起" : `展开 ${hiddenCount} 条会话`}</span>
        </button>
      )}
      <ConfirmDialog
        open={confirmDelete}
        tone="danger"
        title={`删除项目“${props.workspace.name}”？`}
        description="该项目下的所有会话也将被删除，此操作无法撤销。"
        confirmLabel="删除项目"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          props.onDeleteWorkspace(props.workspace.id);
        }}
      />
    </div>
  );
}

