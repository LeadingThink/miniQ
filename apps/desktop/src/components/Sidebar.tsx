import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  Folder,
  MessageSquareText,
  MoreHorizontal,
  PencilLine,
  Pin,
  Plug,
  Puzzle,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Session, Workspace } from "../types";
import type { AppUpdaterState } from "../hooks/useAppUpdater";
import { openExternalUrl } from "../externalLinks";
import { relativeAge } from "../time";
import { sessionStatusLabel } from "../sessionStatus";
import { PROVIDER_LABELS, PROVIDER_MARKS } from "./externalSessionImportModel";
import { UpdateNotice } from "./UpdateNotice";
import { DropdownMenu } from "./DropdownMenu";

const COLLAPSED_SESSION_COUNT = 3;
const FEEDBACK_FORM_URL =
  "https://zaiwen-chattests.feishu.cn/share/base/form/shrcncCk7TJ5Jns8e34ycHSD3yf";

interface SidebarProps {
  workspaces: Workspace[];
  sessions: Session[];
  unreadSessionIds: ReadonlySet<string>;
  currentSessionId: string | null;
  selectedWorkspaceId: string | null;
  onNewChat: () => void;
  onShowSearch: () => void;
  onShowSchedule: () => void;
  onImportSessions: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateSession: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSessionSeen: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
  onSetSessionArchived: (sessionId: string, archived: boolean) => void;
  onShowSkills: () => void;
  onShowMcp: () => void;
  onShowPlugins: () => void;
  onShowSettings: () => void;
  updateSupported: boolean;
  updateState: AppUpdaterState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onError: (message: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedSessions = props.sessions.filter((session) => session.archived);
  return (
    <div className="sidebar">
      <div className="brand">miniQ</div>
      <button type="button" className="nav-item sidebar-nav-button" onClick={props.onNewChat}>
        <PencilLine className="nav-icon" size={16} /> 新对话
      </button>
      <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowSearch}>
        <Search className="nav-icon" size={16} /> 搜索
      </button>
      <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowSchedule}>
        <Clock3 className="nav-icon" size={16} /> 已安排
      </button>
      <button type="button" className="nav-item sidebar-nav-button" onClick={props.onImportSessions}>
        <Download className="nav-icon" size={15} /> 导入会话
      </button>

      {props.workspaces.length > 0 && <div className="sidebar-section">项目</div>}
      <div className="sidebar-scroll">
        {props.workspaces.map((workspace) => (
          <WorkspaceGroup
            currentSessionId={props.currentSessionId}
            key={workspace.id}
            selected={workspace.id === props.selectedWorkspaceId}
            sessions={props.sessions.filter(
              (session) => session.workspaceId === workspace.id && !session.archived,
            )}
            unreadSessionIds={props.unreadSessionIds}
            workspace={workspace}
            onCreateSession={props.onCreateSession}
            onDeleteWorkspace={props.onDeleteWorkspace}
            onRenameWorkspace={props.onRenameWorkspace}
            onSelectSession={props.onSelectSession}
            onSessionSeen={props.onSessionSeen}
            onDeleteSession={props.onDeleteSession}
            onRenameSession={props.onRenameSession}
            onSetSessionPinned={props.onSetSessionPinned}
            onSetSessionArchived={props.onSetSessionArchived}
            onSelectWorkspace={props.onSelectWorkspace}
          />
        ))}
        {props.workspaces.length === 0 && (
          <div className="sidebar-empty">点击新对话选择或创建一个项目开始协作</div>
        )}
        {archivedSessions.length > 0 && (
          <>
            <button
              type="button"
              className="session-toggle"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((current) => !current)}
            >
              <Archive size={13} />
              <span>已归档 {archivedSessions.length}</span>
              {showArchived ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {showArchived &&
              archivedSessions.map((session) => (
                <SessionItem
                  current={session.id === props.currentSessionId}
                  hidden={false}
                  key={session.id}
                  session={session}
                  onSelect={props.onSelectSession}
                  onSeen={props.onSessionSeen}
                  unread={props.unreadSessionIds.has(session.id)}
                  onDelete={props.onDeleteSession}
                  onRename={props.onRenameSession}
                  onSetPinned={props.onSetSessionPinned}
                  onSetArchived={props.onSetSessionArchived}
                />
              ))}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <UpdateNotice
          supported={props.updateSupported}
          state={props.updateState}
          onCheck={props.onCheckForUpdates}
          onInstall={props.onInstallUpdate}
        />
        <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowSkills}>
          <Sparkles className="nav-icon" size={16} /> 技能
        </button>
        <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowMcp}>
          <Plug className="nav-icon" size={16} /> MCP
        </button>
        <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowPlugins}>
          <Puzzle className="nav-icon" size={16} /> 插件
        </button>
        <button
          type="button"
          className="nav-item sidebar-nav-button"
          title="打开反馈表单"
          onClick={() => void openExternalUrl(FEEDBACK_FORM_URL).catch((cause) => {
            props.onError(`无法打开反馈页面：${cause instanceof Error ? cause.message : String(cause)}`);
          })}
        >
          <MessageSquareText className="nav-icon" size={16} /> 反馈
        </button>
        <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowSettings}>
          <Settings className="nav-icon" size={16} /> 设置
        </button>
      </div>
    </div>
  );
}

interface WorkspaceGroupProps {
  workspace: Workspace;
  sessions: Session[];
  unreadSessionIds: ReadonlySet<string>;
  currentSessionId: string | null;
  selected: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateSession: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSessionSeen: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
  onSetSessionArchived: (sessionId: string, archived: boolean) => void;
}

function WorkspaceGroup(props: WorkspaceGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.workspace.name);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);
  const hiddenCount = Math.max(0, props.sessions.length - COLLAPSED_SESSION_COUNT);

  useEffect(() => {
    const currentIndex = props.sessions.findIndex((session) => session.id === props.currentSessionId);
    if (currentIndex >= COLLAPSED_SESSION_COUNT) setExpanded(true);
  }, [props.currentSessionId, props.sessions]);

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
            title={props.workspace.path}
            aria-current={props.selected ? "true" : undefined}
            onClick={() => props.onSelectWorkspace(props.workspace.id)}
          >
            <Folder className="workspace-icon" size={15} />
            <span className="workspace-name">{props.workspace.name}</span>
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
            aria-label="更多操作"
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
                if (window.confirm(`确定要删除项目「${props.workspace.name}」吗？该项目下的所有会话也将被删除。`)) {
                  props.onDeleteWorkspace(props.workspace.id);
                }
              }}
            >
              <Trash2 size={13} />
              <span>删除工作区</span>
            </button>
          </DropdownMenu>
        </div>
      </div>
      {props.sessions.map((session, index) => (
        <SessionItem
          current={session.id === props.currentSessionId}
          hidden={!expanded && index >= COLLAPSED_SESSION_COUNT}
          key={session.id}
          session={session}
          onSelect={props.onSelectSession}
          onSeen={props.onSessionSeen}
          unread={props.unreadSessionIds.has(session.id)}
          onDelete={props.onDeleteSession}
          onRename={props.onRenameSession}
          onSetPinned={props.onSetSessionPinned}
          onSetArchived={props.onSetSessionArchived}
        />
      ))}
      {hiddenCount > 0 && (
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
    </div>
  );
}

function SessionItem(props: {
  session: Session;
  current: boolean;
  hidden: boolean;
  onSelect: (sessionId: string) => void;
  onSeen: (sessionId: string) => void;
  unread: boolean;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onSetPinned: (sessionId: string, pinned: boolean) => void;
  onSetArchived: (sessionId: string, archived: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.session.title);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);
  const external = props.session.external;
  const unread = !props.current && props.unread;
  const statusText = unread ? "新回复" : sessionStatusLabel(props.session.status);

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

  return (
    <div
      className={`session-item ${props.current ? "active" : ""} ${unread ? "unread" : ""} ${props.session.pinned ? "pinned" : ""}`}
      hidden={props.hidden}
      title={`${props.session.title}${unread || props.session.status !== "idle" ? ` · ${statusText}` : ""}`}
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
        <button
          type="button"
          className="session-select"
          aria-current={props.current ? "page" : undefined}
          aria-label={`${props.session.title}${unread || props.session.status !== "idle" ? `，${statusText}` : ""}`}
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
          <span className="session-title">{props.session.title}</span>
          {(unread || props.session.status !== "idle") && (
            <span
              className={`session-state-label ${unread ? "unread" : props.session.status}`}
              role="status"
              aria-label={statusText}
            >
              {statusText}
            </span>
          )}
          <span className="session-age">{relativeAge(props.session.updatedAt)}</span>
        </button>
      )}
      <div className="menu-container">
        <button
          type="button"
          ref={menuBtnRef}
          className="menu-trigger"
          aria-label="更多操作"
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
          <button
            type="button"
            className="dropdown-item"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              props.onSetArchived(props.session.id, !props.session.archived);
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
              if (window.confirm(`确定要删除会话「${props.session.title}」吗？`)) {
                props.onDelete(props.session.id);
              }
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
