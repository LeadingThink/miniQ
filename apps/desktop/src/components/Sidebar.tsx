import { useEffect, useRef, useState } from "react";
import {
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
import { PROVIDER_LABELS, PROVIDER_MARKS } from "./externalSessionImportModel";
import { UpdateNotice } from "./UpdateNotice";

const COLLAPSED_SESSION_COUNT = 3;
const FEEDBACK_FORM_URL =
  "https://zaiwen-chattests.feishu.cn/share/base/form/shrcncCk7TJ5Jns8e34ycHSD3yf";

interface SidebarProps {
  workspaces: Workspace[];
  sessions: Session[];
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
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
  onShowSkills: () => void;
  onShowMcp: () => void;
  onShowSettings: () => void;
  updateSupported: boolean;
  updateState: AppUpdaterState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
}

export function Sidebar(props: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="brand">miniQ</div>
      <div className="nav-item" onClick={props.onNewChat}>
        <PencilLine className="nav-icon" size={16} /> 新对话
      </div>
      <div className="nav-item" onClick={props.onShowSearch}>
        <Search className="nav-icon" size={16} /> 搜索
      </div>
      <div className="nav-item" onClick={props.onShowSchedule}>
        <Clock3 className="nav-icon" size={16} /> 已安排
      </div>
      <div className="nav-item" onClick={props.onImportSessions}>
        <Download className="nav-icon" size={15} /> 导入会话
      </div>

      {props.workspaces.length > 0 && <div className="sidebar-section">项目</div>}
      <div className="sidebar-scroll">
        {props.workspaces.map((workspace) => (
          <WorkspaceGroup
            currentSessionId={props.currentSessionId}
            key={workspace.id}
            selected={workspace.id === props.selectedWorkspaceId}
            sessions={props.sessions.filter((session) => session.workspaceId === workspace.id)}
            workspace={workspace}
            onCreateSession={props.onCreateSession}
            onDeleteWorkspace={props.onDeleteWorkspace}
            onRenameWorkspace={props.onRenameWorkspace}
            onSelectSession={props.onSelectSession}
            onDeleteSession={props.onDeleteSession}
            onRenameSession={props.onRenameSession}
            onSetSessionPinned={props.onSetSessionPinned}
            onSelectWorkspace={props.onSelectWorkspace}
          />
        ))}
        {props.workspaces.length === 0 && (
          <div className="sidebar-empty">点击新对话选择或创建一个项目开始协作</div>
        )}
      </div>

      <div className="sidebar-footer">
        <UpdateNotice
          supported={props.updateSupported}
          state={props.updateState}
          onCheck={props.onCheckForUpdates}
          onInstall={props.onInstallUpdate}
        />
        <div className="nav-item" onClick={props.onShowSkills}>
          <Sparkles className="nav-icon" size={16} /> 技能
        </div>
        <div className="nav-item" onClick={props.onShowMcp}>
          <Plug className="nav-icon" size={16} /> MCP
        </div>
        <button
          type="button"
          className="nav-item sidebar-nav-button"
          title="打开反馈表单"
          onClick={() => void openExternalUrl(FEEDBACK_FORM_URL).catch(() => undefined)}
        >
          <MessageSquareText className="nav-icon" size={16} /> 反馈
        </button>
        <div className="nav-item" onClick={props.onShowSettings}>
          <Settings className="nav-icon" size={16} /> 设置
        </div>
      </div>
    </div>
  );
}

interface WorkspaceGroupProps {
  workspace: Workspace;
  sessions: Session[];
  currentSessionId: string | null;
  selected: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateSession: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
}

function WorkspaceGroup(props: WorkspaceGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.workspace.name);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenCount = Math.max(0, props.sessions.length - COLLAPSED_SESSION_COUNT);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [menuOpen]);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const commitRename = () => {
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
      <div
        className={`workspace-item ${props.selected ? "selected" : ""}`}
        title={props.workspace.path}
        onClick={() => {
          if (!renaming) props.onSelectWorkspace(props.workspace.id);
        }}
      >
        <Folder className="workspace-icon" size={15} />
        {renaming ? (
          <input
            ref={inputRef}
            className="rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setRenameValue(props.workspace.name);
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="workspace-name">{props.workspace.name}</span>
        )}
        <button
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
        <div className="menu-container" ref={menuRef}>
          <button
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
          {menuOpen && (
            <div className="dropdown-menu">
              <button
                className="dropdown-item"
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  setRenameValue(props.workspace.name);
                  setRenaming(true);
                }}
              >
                <PencilLine size={13} />
                <span>重命名</span>
              </button>
              <button
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
            </div>
          )}
        </div>
      </div>
      {props.sessions.map((session, index) => (
        <SessionItem
          current={session.id === props.currentSessionId}
          hidden={!expanded && index >= COLLAPSED_SESSION_COUNT}
          key={session.id}
          session={session}
          onSelect={props.onSelectSession}
          onDelete={props.onDeleteSession}
          onRename={props.onRenameSession}
          onSetPinned={props.onSetSessionPinned}
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
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onSetPinned: (sessionId: string, pinned: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.session.title);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const external = props.session.external;

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [menuOpen]);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const commitRename = () => {
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
      className={`session-item ${props.current ? "active" : ""} ${props.session.pinned ? "pinned" : ""}`}
      hidden={props.hidden}
      onClick={() => {
        if (!renaming) props.onSelect(props.session.id);
      }}
      title={props.session.title}
    >
      <span className={`session-status ${props.session.status}`} />
      {external && (
        <span
          className={`session-source ${external.provider}`}
          title={PROVIDER_LABELS[external.provider]}
        >
          {PROVIDER_MARKS[external.provider]}
        </span>
      )}
      {props.session.pinned && <Pin className="pin-icon" size={12} />}
      {renaming ? (
        <input
          ref={inputRef}
          className="rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setRenameValue(props.session.title);
              setRenaming(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="session-title">{props.session.title}</span>
      )}
      <span className="session-age">{relativeAge(props.session.updatedAt)}</span>
      <div className="menu-container" ref={menuRef}>
        <button
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
        {menuOpen && (
          <div className="dropdown-menu">
            <button
              className="dropdown-item"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                setRenameValue(props.session.title);
                setRenaming(true);
              }}
            >
              <PencilLine size={13} />
              <span>重命名</span>
            </button>
            <button
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
          </div>
        )}
      </div>
    </div>
  );
}

