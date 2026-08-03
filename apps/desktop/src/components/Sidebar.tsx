import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  Folder,
  MessageSquareText,
  PencilLine,
  Plug,
  Plus,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import type { Session, Workspace } from "../types";
import { openExternalUrl } from "../externalLinks";
import { relativeAge } from "../time";
import { PROVIDER_LABELS, PROVIDER_MARKS } from "./externalSessionImportModel";

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
  onSelectSession: (sessionId: string) => void;
  onShowSkills: () => void;
  onShowMcp: () => void;
  onShowSettings: () => void;
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
            onSelectSession={props.onSelectSession}
            onSelectWorkspace={props.onSelectWorkspace}
          />
        ))}
        {props.workspaces.length === 0 && (
          <div className="sidebar-empty">点击新对话选择或创建一个项目开始协作</div>
        )}
      </div>

      <div className="sidebar-footer">
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
  onSelectSession: (sessionId: string) => void;
}

function WorkspaceGroup(props: WorkspaceGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, props.sessions.length - COLLAPSED_SESSION_COUNT);

  return (
    <div className="workspace-group">
      <div
        className={`workspace-item ${props.selected ? "selected" : ""}`}
        title={props.workspace.path}
        onClick={() => props.onSelectWorkspace(props.workspace.id)}
      >
        <Folder className="workspace-icon" size={15} />
        <span className="workspace-name">{props.workspace.name}</span>
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
      </div>
      {props.sessions.map((session, index) => (
        <SessionItem
          current={session.id === props.currentSessionId}
          hidden={!expanded && index >= COLLAPSED_SESSION_COUNT}
          key={session.id}
          session={session}
          onSelect={props.onSelectSession}
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
}) {
  const external = props.session.external;
  return (
    <div
      className={`session-item ${props.current ? "active" : ""}`}
      hidden={props.hidden}
      onClick={() => props.onSelect(props.session.id)}
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
      <span className="session-title">{props.session.title}</span>
      <span className="session-age">{relativeAge(props.session.updatedAt)}</span>
    </div>
  );
}
