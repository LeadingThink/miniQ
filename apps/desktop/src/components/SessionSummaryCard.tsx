import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Globe,
  X,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useMobileLayout } from "../hooks/useMobileLayout";
import { Dialog } from "./ui/Dialog";
import {
  SESSION_TOOLBAR_ACTION_EVENT,
  type SessionToolbarActionDetail,
} from "./TimelineToolbar";
import type { PullRequestRef, WebSource } from "../sessionContext";
import type { AgentSummary } from "./AgentSummary";
import "./SessionSummaryCard.css";

export type SessionSummarySection = "agents" | "sources" | "pulls";

const ONGOING = new Set([
  "running",
  "stopping",
  "finalizing",
  "queued",
  "waiting",
  "waiting_approval",
]);
const COLLAPSED_KEY = "miniq.sessionSummary.collapsed";

export interface SessionSummaryCardProps {
  sessionId: string;
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
    const stored = window.localStorage.getItem(COLLAPSED_KEY);
    return stored === null || stored === "1";
  } catch {
    return true;
  }
}

export function agentProgress(agents: readonly AgentSummary[]) {
  return {
    completed: agents.filter((agent) => agent.status === "completed").length,
    ongoing: agents.filter((agent) => ONGOING.has(agent.status)).length,
  };
}

/** Phones open the summary from the session menu; desktop keeps its popover. */
export function SessionSummaryCard(props: SessionSummaryCardProps) {
  const mobile = useMobileLayout();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (!mobile) return;
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<SessionToolbarActionDetail>).detail;
      if (detail?.action === "summary" && detail.sessionId === props.sessionId)
        setMobileOpen(true);
    };
    window.addEventListener(SESSION_TOOLBAR_ACTION_EVENT, onAction);
    return () =>
      window.removeEventListener(SESSION_TOOLBAR_ACTION_EVENT, onAction);
  }, [mobile, props.sessionId]);
  useEffect(() => {
    setMobileOpen(false);
  }, [mobile, props.sessionId]);
  useEffect(() => {
    if (mobile && props.expanded) setMobileOpen(true);
  }, [mobile, props.expanded]);
  if (mobile) {
    const close = () => {
      setMobileOpen(false);
      props.onExpandedChange(null);
    };
    return (
      <Dialog
        open={mobileOpen}
        title="会话摘要"
        description="修改、子任务与参考资料"
        className="session-summary-sheet"
        onClose={close}
      >
        <button
          type="button"
          className="icon-button session-summary-close"
          aria-label="收起会话摘要"
          onClick={close}
        >
          <X size={20} />
        </button>
        <SessionSummaryContent
          {...props}
          onOpenReview={() => {
            close();
            props.onOpenReview();
          }}
          onOpenUrl={(url) => {
            close();
            props.onOpenUrl(url);
          }}
        />
      </Dialog>
    );
  }
  return <DesktopSummaryPopover {...props} />;
}

function DesktopSummaryPopover(props: SessionSummaryCardProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const panelId = useId();
  if (!hasSummaryContent(props)) return null;
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage can be unavailable in private contexts; the toggle still works.
    }
  };
  return (
    <aside
      className={`session-summary${collapsed ? " is-collapsed" : ""}`}
      aria-label="会话摘要"
    >
      <button
        type="button"
        className="session-summary-trigger"
        aria-label="会话摘要"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        title={collapsed ? "展开会话摘要" : "收起会话摘要"}
        onClick={toggleCollapsed}
      >
        <span>会话摘要</span>
        {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      <div id={panelId} className="session-summary-popover">
        <header className="session-summary-heading">
          <div>
            <strong>会话摘要</strong>
            <span>修改、子任务与参考资料</span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="收起会话摘要"
            onClick={toggleCollapsed}
          >
            <X size={15} />
          </button>
        </header>
        <SessionSummaryContent {...props} />
      </div>
    </aside>
  );
}

function hasSummaryContent(props: SessionSummaryCardProps) {
  return (
    props.diff.files.length > 0 ||
    props.agents.length > 0 ||
    !!props.agentError ||
    props.sources.length > 0 ||
    props.pullRequests.length > 0
  );
}

function SessionSummaryContent(props: SessionSummaryCardProps) {
  const sectionId = useId();
  if (!hasSummaryContent(props))
    return (
      <p className="session-summary-empty">
        当前会话暂无修改、子任务或参考资料。
      </p>
    );
  return (
    <>
      <SessionSummaryItems {...props} sectionId={sectionId} />
      {props.expanded === "agents" &&
        (props.agents.length > 0 || props.agentError) && (
          <div id={`${sectionId}-agents`} className="session-summary-detail">
            {props.agentPanel}
          </div>
        )}
      {props.expanded === "sources" && (
        <SummaryLinks
          id={`${sectionId}-sources`}
          label="来源"
          links={props.sources.map((source) => ({
            url: source.url,
            title: source.title ?? source.domain,
            detail: `${source.domain}${source.via === "search" ? " · 搜索结果" : ""}`,
          }))}
          onOpen={props.onOpenUrl}
        />
      )}
      {props.expanded === "pulls" && (
        <SummaryLinks
          id={`${sectionId}-pulls`}
          label="拉取请求"
          links={props.pullRequests.map((pull) => ({
            url: pull.url,
            title: `#${pull.number}`,
            detail: `${pull.owner}/${pull.repo}`,
          }))}
          onOpen={props.onOpenUrl}
        />
      )}
    </>
  );
}

function SummaryLinks({
  id,
  label,
  links,
  onOpen,
}: {
  id: string;
  label: string;
  links: { url: string; title: string; detail: string }[];
  onOpen: (url: string) => void;
}) {
  if (!links.length) return null;
  return (
    <ul
      id={id}
      className="session-summary-detail session-summary-links"
      aria-label={label}
    >
      {links.map((link) => (
        <li key={link.url}>
          <button
            type="button"
            title={link.url}
            onClick={() => onOpen(link.url)}
          >
            <strong>{link.title}</strong>
            <small>{link.detail}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SessionSummaryItems(
  props: SessionSummaryCardProps & { sectionId: string },
) {
  const hasChanges = props.diff.files.length > 0;
  const hasAgents = props.agents.length > 0 || !!props.agentError;
  const hasSources = props.sources.length > 0;
  const hasPulls = props.pullRequests.length > 0;
  const toggle = (section: SessionSummarySection) =>
    props.onExpandedChange(props.expanded === section ? null : section);
  const progress = agentProgress(props.agents);
  const sectionButton = (
    section: SessionSummarySection,
    label: string,
    icon: ReactNode,
    value: ReactNode,
  ) => (
    <button
      type="button"
      className="session-summary-item"
      aria-expanded={props.expanded === section}
      aria-controls={`${props.sectionId}-${section}`}
      onClick={() => toggle(section)}
    >
      {icon}
      <span className="session-summary-label">{label}</span>
      <span className="session-summary-value">{value}</span>
      <ChevronRight
        size={14}
        className="session-summary-chevron"
        aria-hidden="true"
      />
    </button>
  );

  return (
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
          <span className="session-summary-file-count">
            {props.diff.files.length} 个文件
          </span>
          <span className="session-summary-value">
            <span className="diff-add">+{props.diff.additions}</span>{" "}
            <span className="diff-delete">-{props.diff.deletions}</span>
          </span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
      {hasAgents &&
        sectionButton(
          "agents",
          "子智能体",
          <GitBranch size={14} aria-hidden="true" />,
          <>
            {progress.completed} 完成 / {progress.ongoing} 进行中
          </>,
        )}
      {hasSources &&
        sectionButton(
          "sources",
          "来源",
          <Globe size={14} aria-hidden="true" />,
          props.sources.length,
        )}
      {hasPulls &&
        sectionButton(
          "pulls",
          "拉取请求",
          <GitPullRequest size={14} aria-hidden="true" />,
          props.pullRequests.length,
        )}
    </div>
  );
}
