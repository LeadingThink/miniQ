import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Download,
  Folder,
  MessageSquareText,
  MoreHorizontal,
  PencilLine,
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
import { UpdateNotice } from "./UpdateNotice";
import { DropdownMenu } from "./DropdownMenu";
import { SidebarPanel } from "./SidebarPanel";
import { SidebarSessionItem } from "./SidebarSessionItem";
import { handleSidebarNavigation, SidebarFilters, sidebarGroups, useProjectDisclosure, type SidebarFilter } from "./SidebarNavigation";
import "./Sidebar.css";

const COLLAPSED_SESSION_COUNT = 3;
const FEEDBACK_FORM_URL =
  "https://zaiwen-chattests.feishu.cn/share/base/form/shrcncCk7TJ5Jns8e34ycHSD3yf";

export interface SidebarHostGroup {
  key: string;
  label: string;
  state: string;
  error?: string;
  workspaceIds: string[];
  selected: boolean;
  onSelect: () => void;
}

interface SidebarProps {
  hostGroups?: SidebarHostGroup[];
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
  onEditWorkspace: (workspaceId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSessionSeen: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
  onSetSessionArchived: (sessionId: string, archived: boolean) => void;
  onShowSkills: () => void;
  onShowMcp: () => void;
  onShowPlugins?: () => void;
  onShowSettings: () => void;
  updateSupported: boolean;
  updateState: AppUpdaterState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onError: (message: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const [showArchived, setShowArchived] = useState(() => props.sessions.some((session) => session.id === props.currentSessionId && session.archived));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const navigation = useMemo(() => sidebarGroups(props.workspaces, props.sessions, props.unreadSessionIds, query, filter),
    [props.workspaces, props.sessions, props.unreadSessionIds, query, filter]);
  const previousSession = useRef({ id: props.currentSessionId, revealed: false });
  useEffect(() => {
    if (previousSession.current.id !== props.currentSessionId) {
      previousSession.current = { id: props.currentSessionId, revealed: false };
    }
    if (previousSession.current.revealed) return;
    const selected = props.sessions.find((session) => session.id === props.currentSessionId);
    if (!selected) return;
    previousSession.current.revealed = true;
    if (selected?.archived) setShowArchived(true);
  }, [props.currentSessionId, props.sessions]);
  const archivedSessions = navigation.archived;
  const archiveOpen = showArchived || navigation.filtering;
  return (
    <SidebarPanel>
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

      {props.workspaces.length > 0 && <SidebarFilters query={query} filter={filter} counts={navigation.counts} onQuery={setQuery} onFilter={setFilter} />}
      <div className="sidebar-scroll" role="navigation" aria-label="项目与会话" onKeyDown={handleSidebarNavigation}>
        {props.hostGroups?.filter((host) => !host.workspaceIds.length).map((host) => <HostHeading key={host.key} host={host} />)}
        {navigation.groups.map(({ workspace, sessions }, index) => (
          <Fragment key={workspace.id}>
          {props.hostGroups?.filter((host) => host.workspaceIds.includes(workspace.id) && !navigation.groups.slice(0, index).some((group) => host.workspaceIds.includes(group.workspace.id))).map((host) => <HostHeading key={host.key} host={host} />)}
          <WorkspaceGroup
            currentSessionId={props.currentSessionId}
            key={workspace.id}
            selected={workspace.id === props.selectedWorkspaceId}
            sessions={sessions}
            filtering={navigation.filtering}
            unreadSessionIds={props.unreadSessionIds}
            workspace={workspace}
            onCreateSession={props.onCreateSession}
            onDeleteWorkspace={props.onDeleteWorkspace}
            onRenameWorkspace={props.onRenameWorkspace}
            onEditWorkspace={props.onEditWorkspace}
            onSelectSession={props.onSelectSession}
            onSessionSeen={props.onSessionSeen}
            onDeleteSession={props.onDeleteSession}
            onRenameSession={props.onRenameSession}
            onSetSessionPinned={props.onSetSessionPinned}
            onSetSessionArchived={props.onSetSessionArchived}
            onSelectWorkspace={props.onSelectWorkspace}
          />
          </Fragment>
        ))}
        {props.workspaces.length === 0 && (
          <div className="sidebar-empty">点击新对话选择或创建一个项目开始协作</div>
        )}
        {navigation.filtering && navigation.groups.length === 0 && archivedSessions.length === 0 && (
          <div className="sidebar-filter-empty" role="status">
            没有符合条件的会话
            <button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选，查看全部</button>
          </div>
        )}
        {archivedSessions.length > 0 && (
          <>
            <button
              type="button"
              className="session-toggle"
              aria-expanded={archiveOpen}
              disabled={navigation.filtering}
              onClick={() => setShowArchived((current) => !current)}
            >
              <Archive size={13} />
              <span>已归档 {archivedSessions.length}</span>
              {archiveOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {archiveOpen &&
              archivedSessions.map((session) => (
                <SidebarSessionItem
                  current={session.id === props.currentSessionId}
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
        <button
          type="button"
          className="nav-item sidebar-nav-button"
          onClick={() => props.onShowPlugins?.()}
        >
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
    </SidebarPanel>
  );
}

function HostHeading({ host }: { host: SidebarHostGroup }) {
  const state = { connected: "已连接", connecting: "连接中", disconnected: "未连接", error: "连接失败" }[host.state] ?? host.state;
  return <div className="sidebar-host" data-state={host.state}>
    <button type="button" className="sidebar-host-heading" aria-current={host.selected ? "location" : undefined} onClick={host.onSelect} title={host.error ?? `${host.label} · ${state}`}>
      <span>{host.label}</span><small>{state}</small>
    </button>
    {host.error && <p className="sidebar-host-error">{host.error}</p>}
  </div>;
}

interface WorkspaceGroupProps {
  workspace: Workspace;
  sessions: Session[];
  unreadSessionIds: ReadonlySet<string>;
  currentSessionId: string | null;
  selected: boolean;
  filtering: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateSession: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onEditWorkspace: (workspaceId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSessionSeen: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
  onSetSessionArchived: (sessionId: string, archived: boolean) => void;
}

function WorkspaceGroup(props: WorkspaceGroupProps) {
  const [preferredOpen, setOpen] = useProjectDisclosure(props.workspace.id);
  const open = props.filtering || preferredOpen;
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.workspace.name);
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
            <button type="button" className="dropdown-item" onClick={() => {
              setMenuOpen(false);
              props.onEditWorkspace(props.workspace.id);
            }}>
              <Folder size={13} /><span>项目目录</span>
            </button>
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
      {visibleSessions.map((session) => (
        <SidebarSessionItem
          current={session.id === props.currentSessionId}
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
    </div>
  );
}
