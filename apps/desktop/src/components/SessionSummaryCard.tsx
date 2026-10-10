import { ChevronDown, ChevronUp, FileDiff, GitBranch, GitPullRequest, Globe } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { PullRequestRef, WebSource } from "../sessionContext";
import { AgentAvatar, orderAgentsForSummary, type AgentSummary } from "./AgentSummary";
import "./SessionSummaryCard.css";

export type SessionSummarySection = "agents" | "sources" | "pulls";

const ONGOING = new Set(["running", "stopping", "finalizing", "queued", "waiting", "waiting_approval"]);
const AVATAR_STACK = 4;
const COLLAPSED_KEY = "miniq.sessionSummary.collapsed";

export interface SessionSummaryCardProps {
  diff: { files: readonly unknown[]; additions: number; deletions: number };
  agents: AgentSummary[];
  agentError?: string | null;
  sources: WebSource[];
  pullRequests: PullRequestRef[];
  expanded: SessionSummarySection | null;
  onExpandedChange: (section: SessionSummarySection | null) => void;
  onOpenReview: () => void;
  onOpenUrl: (url: string) => void;
  /** The full child-agent panel, shown when the agent section is expanded. */
  agentPanel: ReactNode;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function agentProgress(agents: readonly AgentSummary[]) {
  return {
    completed: agents.filter((agent) => agent.status === "completed").length,
    ongoing: agents.filter((agent) => ONGOING.has(agent.status)).length,
  };
}

/** Session-level context: changes, child agents, web sources and pull
 * requests. A floating card on wide layouts and one chip row on narrow ones;
 * empty sections are omitted and the card disappears when all are empty. */
export function SessionSummaryCard(props: SessionSummaryCardProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const hasChanges = props.diff.files.length > 0;
  const hasAgents = props.agents.length > 0 || !!props.agentError;
  const hasSources = props.sources.length > 0;
  const hasPulls = props.pullRequests.length > 0;
  if (!hasChanges && !hasAgents && !hasSources && !hasPulls) return null;

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage can be unavailable in private contexts; the toggle still works.
    }
  };
  const toggle = (section: SessionSummarySection) =>
    props.onExpandedChange(props.expanded === section ? null : section);
  const progress = agentProgress(props.agents);
  const ordered = orderAgentsForSummary(props.agents);
  const sectionButton = (section: SessionSummarySection, label: string, icon: ReactNode, value: ReactNode) => (
    <button
      type="button"
      className="session-summary-item"
      aria-expanded={props.expanded === section}
      aria-controls={`session-summary-${section}`}
      onClick={() => toggle(section)}
    >
      {icon}
      <span className="session-summary-label">{label}</span>
      <span className="session-summary-value">{value}</span>
    </button>
  );

  return (
    <aside className={`session-summary${collapsed ? " is-collapsed" : ""}`} aria-label="会话摘要">
      <div className="session-summary-head">
        <span>会话摘要</span>
        <button
          type="button"
          className="icon-button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "展开会话摘要" : "收起会话摘要"}
          title={collapsed ? "展开会话摘要" : "收起会话摘要"}
          onClick={toggleCollapsed}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      <div className="session-summary-items">
        {hasChanges && (
          <button
            type="button"
            className="session-summary-item"
            title="在审阅面板查看本会话的修改"
            onClick={props.onOpenReview}
          >
            <FileDiff size={14} aria-hidden="true" />
            <span className="session-summary-label">变更</span>
            <span className="session-summary-value">
              <span className="diff-add">+{props.diff.additions}</span>{" "}
              <span className="diff-delete">-{props.diff.deletions}</span>
            </span>
          </button>
        )}
        {hasAgents && sectionButton(
          "agents",
          "子智能体",
          <GitBranch size={14} aria-hidden="true" />,
          <>
            <span className="session-summary-avatars">
              {ordered.slice(0, AVATAR_STACK).map((agent) => (
                <AgentAvatar key={agent.agentId} seed={agent.agentId} name={agent.name} status={agent.status} />
              ))}
            </span>
            {progress.completed} 完成 / {progress.ongoing} 进行中
          </>,
        )}
        {hasSources && sectionButton("sources", "来源", <Globe size={14} aria-hidden="true" />, props.sources.length)}
        {hasPulls && sectionButton(
          "pulls",
          "拉取请求",
          <GitPullRequest size={14} aria-hidden="true" />,
          props.pullRequests.length,
        )}
      </div>
      {props.expanded === "agents" && hasAgents && (
        <div id="session-summary-agents" className="session-summary-detail">
          {props.agentPanel}
        </div>
      )}
      {props.expanded === "sources" && hasSources && (
        <ul id="session-summary-sources" className="session-summary-detail session-summary-links" aria-label="来源">
          {props.sources.map((source) => (
            <li key={source.url}>
              <button type="button" title={source.url} onClick={() => props.onOpenUrl(source.url)}>
                <strong>{source.title ?? source.domain}</strong>
                <small>{source.domain}{source.via === "search" ? " · 搜索结果" : ""}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {props.expanded === "pulls" && hasPulls && (
        <ul id="session-summary-pulls" className="session-summary-detail session-summary-links" aria-label="拉取请求">
          {props.pullRequests.map((pull) => (
            <li key={pull.url}>
              <button type="button" title={pull.url} onClick={() => props.onOpenUrl(pull.url)}>
                <strong>#{pull.number}</strong>
                <small>{pull.owner}/{pull.repo}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
