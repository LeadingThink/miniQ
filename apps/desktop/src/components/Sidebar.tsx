import { useState } from "react";
import type { Session, Workspace } from "../types";
import { relativeAge } from "../time";

/** Sessions shown per workspace before the "展开显示" toggle kicks in. */
const COLLAPSED_SESSION_COUNT = 3;

export function Sidebar(props: {
  workspaces: Workspace[];
  sessions: Session[];
  currentSessionId: string | null;
  selectedWorkspaceId: string | null;
  onNewChat: () => void;
  onShowSearch: () => void;
  onShowSchedule: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateSession: (workspaceId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onShowSkills: () => void;
  onShowMcp: () => void;
  onShowSettings: () => void;
}) {
  // Workspace ids whose session list is fully expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (workspaceId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });

  return (
    <div className="sidebar">
      <div className="brand">miniQ</div>

      <div className="nav-item" onClick={props.onNewChat}>
        <span className="nav-icon">✎</span> 新对话
      </div>
      <div className="nav-item" onClick={props.onShowSearch}>
        <span className="nav-icon">🔍</span> 搜索
      </div>
      <div className="nav-item" onClick={props.onShowSchedule}>
        <span className="nav-icon">◷</span> 已安排
      </div>

      {props.workspaces.length > 0 && <div className="sidebar-section">项目</div>}
      <div className="sidebar-scroll">
        {props.workspaces.map((ws) => {
          const sessions = props.sessions.filter((s) => s.workspaceId === ws.id);
          const isOpen = expanded.has(ws.id);
          const visibleSessions = isOpen
            ? sessions
            : sessions.slice(0, COLLAPSED_SESSION_COUNT);
          const hiddenCount = sessions.length - COLLAPSED_SESSION_COUNT;
          return (
            <div key={ws.id} className="workspace-group">
              <div
                className={`workspace-item ${
                  ws.id === props.selectedWorkspaceId ? "selected" : ""
                }`}
                title={ws.path}
                onClick={() => props.onSelectWorkspace(ws.id)}
              >
                <span className="nav-icon">🗂</span>
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {ws.name}
                </span>
                <span
                  className="new-session"
                  title="新建会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onCreateSession(ws.id);
                  }}
                >
                  +
                </span>
              </div>
              {visibleSessions.map((s) => (
                <div
                  key={s.id}
                  className={`session-item ${s.id === props.currentSessionId ? "active" : ""}`}
                  onClick={() => props.onSelectSession(s.id)}
                  title={s.title}
                >
                  <span className={`session-status ${s.status}`} />
                  <span className="session-title">{s.title}</span>
                  <span className="session-age">{relativeAge(s.updatedAt)}</span>
                </div>
              ))}
              {hiddenCount > 0 && (
                <div className="session-toggle" onClick={() => toggleExpanded(ws.id)}>
                  <span className={`chevron ${isOpen ? "open" : ""}`}>›</span>
                  {isOpen ? "收起" : `展开显示 ${hiddenCount} 条`}
                </div>
              )}
            </div>
          );
        })}
        {props.workspaces.length === 0 && (
          <div className="sidebar-empty">点击"新对话"选择或创建一个项目开始协作。</div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="nav-item" onClick={props.onShowSkills}>
          <span className="nav-icon">✦</span> 技能
        </div>
        <div className="nav-item" onClick={props.onShowMcp}>
          <span className="nav-icon">🔌</span> MCP
        </div>
        <div className="nav-item" onClick={props.onShowSettings}>
          <span className="nav-icon">⚙</span> 设置
        </div>
      </div>
    </div>
  );
}
