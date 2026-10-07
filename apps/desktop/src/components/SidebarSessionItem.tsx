import { useEffect, useId, useRef, useState } from "react";
import { Archive, ArchiveRestore, Mail, MailOpen, MoreHorizontal, PencilLine, Pin, Trash2 } from "lucide-react";
import type { Session } from "../types";
import { relativeAge } from "../time";
import { sessionStatusLabel } from "../sessionStatus";
import { PROVIDER_LABELS, PROVIDER_MARKS } from "./externalSessionImportModel";
import { SessionPreview } from "./SessionPreview";
import { DropdownMenu } from "./DropdownMenu";
import { showUndoToast, useToast } from "./ui/Toast";

export function SidebarSessionItem(props: {
  session: Session;
  current: boolean;
  contextLabel?: string;
  onSelect: (sessionId: string) => void;
  onSeen: (sessionId: string) => void;
  unread: boolean;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onSetPinned: (sessionId: string, pinned: boolean) => void;
  onSetArchived: (sessionId: string, archived: boolean) => void;
  onMarkUnread?: (sessionId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.session.title);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const contextId = useId();
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState(false);
  const external = props.session.external;
  const unread = !props.current && props.unread;
  const statusText = unread ? "新回复" : sessionStatusLabel(props.session.status);

  useEffect(() => {
    if (props.current) itemRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [props.current]);

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
    if (trimmed && trimmed !== props.session.title) {
      props.onRename(props.session.id, trimmed);
    } else {
      setRenameValue(props.session.title);
    }
  };

  const preview = props.session.preview?.replace(/\s+/g, " ").trim();
  const activityAt = sessionActivityAt(props.session);

  // Optimistically hidden while the undo toast is visible.
  if (pendingDelete) return null;

  return (
    <div
      ref={itemRef}
      className={`session-item ${props.current ? "active" : ""} ${unread ? "unread" : ""} ${props.session.pinned ? "pinned" : ""}`}

    >
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
              setRenameValue(props.session.title);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <SessionPreview title={props.session.title} preview={preview} contextLabel={props.contextLabel}
          detail={`${statusText} · ${relativeAge(activityAt)}`} disabled={menuOpen}>
        <button
          type="button"
          className="session-select"
          aria-current={props.current ? "page" : undefined}
          aria-label={`${props.session.title}${unread || props.session.status !== "idle" ? `，${statusText}` : ""}`}
          aria-describedby={props.contextLabel ? contextId : undefined}
          onClick={() => {
            props.onSeen(props.session.id);
            props.onSelect(props.session.id);
          }}
        >
          <span
            className={`session-status ${props.session.status} ${unread ? "unread" : ""}`}
            aria-hidden="true"
          />
          {external && (
            <span className={`session-source ${external.provider}`} title={PROVIDER_LABELS[external.provider]}>
              {PROVIDER_MARKS[external.provider]}
            </span>
          )}
          {props.session.pinned && <Pin className="pin-icon" size={12} />}
          <span className={`session-copy${props.contextLabel ? " with-context" : ""}`}>
          <span className="session-title">{props.session.title}</span>
          <span className="session-meta">
          {props.contextLabel && <span id={contextId} className="session-context">{props.contextLabel}</span>}
          {(unread || props.session.status !== "idle") && (
            <span
              className={`session-state-label ${unread ? "unread" : props.session.status}`}
              role="status"
              aria-label={statusText}
            >
              {statusText}
            </span>
          )}
          <span className="session-age">{relativeAge(activityAt).replace(/ /g, "").replace("分钟", "分").replace("小时", "时")}</span>
          </span>
          </span>
        </button>
        </SessionPreview>
      )}
      <div className="menu-container">
        <button
          type="button"
          ref={menuBtnRef}
          className="menu-trigger"
          aria-label={`${props.session.title} 的更多操作`}
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
          <div className="session-menu-summary">
            <strong>{props.session.title}</strong>
            <small>{props.contextLabel ? `${props.contextLabel} · ` : ""}{statusText}</small>
            {preview && <p>{preview}</p>}
          </div>
          <button
            type="button"
            className="dropdown-item"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              renameCommittedRef.current = false;
              setRenameValue(props.session.title);
              setRenaming(true);
            }}
          >
            <PencilLine size={13} />
            <span>重命名</span>
          </button>
          <button
            type="button"
            className="dropdown-item"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              props.onSetPinned(props.session.id, !props.session.pinned);
            }}
          >
            <Pin size={13} />
            <span>{props.session.pinned ? "取消置顶" : "置顶"}</span>
          </button>
          {props.onMarkUnread && (
            <button
              type="button"
              className="dropdown-item"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                if (props.unread) props.onSeen(props.session.id);
                else props.onMarkUnread?.(props.session.id);
              }}
            >
              {props.unread ? <MailOpen size={13} /> : <Mail size={13} />}
              <span>{props.unread ? "标为已读" : "标为未读"}</span>
            </button>
          )}
          <button
            type="button"
            className="dropdown-item"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              const sessionId = props.session.id;
              const archived = !props.session.archived;
              const onSetArchived = props.onSetArchived;
              onSetArchived(sessionId, archived);
              if (archived) {
                showUndoToast(toast, {
                  message: `已归档会话“${props.session.title}”`,
                  onCommit: () => {},
                  onUndo: () => onSetArchived(sessionId, false),
                });
              }
            }}
          >
            {props.session.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            <span>{props.session.archived ? "取消归档" : "归档"}</span>
          </button>
          <button
            type="button"
            className="dropdown-item danger"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              const sessionId = props.session.id;
              const onDelete = props.onDelete;
              setPendingDelete(true);
              showUndoToast(toast, {
                message: `已删除会话“${props.session.title}”`,
                onCommit: () => onDelete(sessionId),
                onUndo: () => setPendingDelete(false),
              });
            }}
          >
            <Trash2 size={13} />
            <span>删除会话</span>
          </button>
        </DropdownMenu>
      </div>
    </div>
  );
}

function sessionActivityAt(session: Session): string {
  const value = session.lastActivityAt;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return session.updatedAt;
}
