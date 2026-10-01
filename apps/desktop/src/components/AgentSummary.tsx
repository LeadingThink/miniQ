import type { TurnProgress } from "../types";
import { Activity, CircleAlert, LoaderCircle, PauseCircle } from "lucide-react";
import "./AgentSummary.css";

export interface AgentSummary {
  agentId: string;
  parentId: string | null;
  name: string;
  description: string;
  status: string;
  model: string | null;
  createdAt: string;
  queuedMessages: number;
  error: string | null;
  result?: string | null;
  progress?: TurnProgress | null;
  elapsedMs?: number;
  timingComplete?: boolean;
  heldMessagesCount?: number;
  heldMessages?: string[];
}

const ACTIVE = new Set(["running", "stopping", "finalizing"]);
const EXCEPTION = new Set(["failed", "interrupted"]);
const WAITING = new Set(["queued", "waiting", "waiting_approval"]);

export const AGENT_AVATAR_TONES = 8;

/** Stable per-agent tone, so the same child keeps one identity in the
 * timeline, panel and history (same idea as ChatGPT's seeded avatars). */
export function agentAvatarTone(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 2147483647;
  }
  return hash % AGENT_AVATAR_TONES;
}

function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return Array.from(trimmed)[0]!.toLocaleUpperCase();
}

export function AgentAvatar({
  seed,
  name,
  status,
  className,
}: {
  seed: string;
  name: string;
  status?: string;
  className?: string;
}) {
  const state = status
    ? ACTIVE.has(status)
      ? "active"
      : EXCEPTION.has(status)
        ? "failed"
        : status === "completed"
          ? "completed"
          : WAITING.has(status)
            ? "waiting"
            : "other"
    : undefined;
  return (
    <span
      className={`agent-avatar${className ? ` ${className}` : ""}`}
      data-tone={agentAvatarTone(seed)}
      data-state={state}
      aria-hidden="true"
    >
      {avatarInitial(name)}
    </span>
  );
}

const INDICATOR_PRIORITY = (status: string) =>
  ACTIVE.has(status) ? 0 : WAITING.has(status) ? 1 : EXCEPTION.has(status) ? 2 : status === "completed" ? 3 : 4;

/** Agents in the order the inline summary names them. */
export function orderAgentsForSummary(agents: AgentSummary[]): AgentSummary[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => INDICATOR_PRIORITY(a.agent.status) - INDICATOR_PRIORITY(b.agent.status) || a.index - b.index)
    .map(({ agent }) => agent);
}

function agentDisplayName(agent: AgentSummary): string {
  return agent.name.trim() || agent.description.trim() || "子任务";
}

const PHASE_LABELS: Record<TurnProgress["phase"], string> = {
  preparing_context: "读取上下文",
  compacting_context: "整理上下文",
  requesting_model: "请求模型",
  receiving_model: "接收响应",
  waiting_retry: "等待重试",
  finalizing: "保存结果",
};

function phaseSummary(agents: AgentSummary[]): string | null {
  const phases = new Map<string, number>();
  for (const agent of agents) {
    if (!ACTIVE.has(agent.status) || !agent.progress) continue;
    const label = PHASE_LABELS[agent.progress.phase];
    phases.set(label, (phases.get(label) ?? 0) + 1);
  }
  if (phases.size === 0) return null;
  return [...phases.entries()]
    .map(([label, count]) => `${label}${count > 1 ? ` ${count}` : ""}`)
    .join(" · ");
}

function stepSummary(agents: AgentSummary[]): string | null {
  const steps = agents
    .filter((agent) => ACTIVE.has(agent.status))
    .map((agent) => agent.progress?.modelStep)
    .filter((step): step is number => typeof step === "number");
  if (steps.length === 0) return null;
  const unique = [...new Set(steps)].sort((a, b) => a - b);
  return unique.length === 1 ? `第 ${unique[0]} 轮` : `第 ${unique.join("、")} 轮`;
}

function summarizeAgents(agents: AgentSummary[]) {
  const active = agents.filter((agent) => ACTIVE.has(agent.status)).length;
  const completed = agents.filter((agent) => agent.status === "completed").length;
  const failed = agents.filter((agent) => EXCEPTION.has(agent.status)).length;
  const waitingToRetry = agents.filter(
    (agent) => ACTIVE.has(agent.status) && agent.progress?.phase === "waiting_retry",
  ).length;
  const queued = agents.filter(
    (agent) => WAITING.has(agent.status),
  ).length;
  const cancelled = agents.filter((agent) => agent.status === "cancelled").length;
  return {
    active,
    running: active - waitingToRetry,
    waiting: queued + waitingToRetry,
    completed,
    failed,
    cancelled,
    other: Math.max(0, agents.length - active - completed - failed),
    phase: phaseSummary(agents),
    step: stepSummary(agents),
  };
}

function StatusStat({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "active" | "completed" | "failed" | "other";
}) {
  return (
    <span className={`agent-stat agent-stat-${tone}`}>
      <strong>{count}</strong>
      <span>{label}</span>
    </span>
  );
}

export function AgentSummaryStats({ agents }: { agents: AgentSummary[] }) {
  const { active, completed, failed, other, phase, step } = summarizeAgents(agents);
  return (
    <span className="agent-summary" aria-label={`子任务状态：${active} 个执行中，${completed} 个已完成，${failed} 个异常`}>
      <span className="agent-summary-stats">
        <StatusStat label="执行中" count={active} tone="active" />
        <StatusStat label="已完成" count={completed} tone="completed" />
        <StatusStat label="异常" count={failed} tone="failed" />
        {other > 0 && <StatusStat label="其他" count={other} tone="other" />}
      </span>
      <span
        className="agent-summary-segments"
        role="img"
        aria-label={`状态分段：执行中 ${active}，已完成 ${completed}，异常 ${failed}${other ? `，其他 ${other}` : ""}`}
      >
        {active > 0 && <span className="agent-summary-segment active" style={{ flexGrow: active }} title={`执行中 ${active}`} />}
        {completed > 0 && <span className="agent-summary-segment completed" style={{ flexGrow: completed }} title={`已完成 ${completed}`} />}
        {failed > 0 && <span className="agent-summary-segment failed" style={{ flexGrow: failed }} title={`异常 ${failed}`} />}
        {other > 0 && <span className="agent-summary-segment other" style={{ flexGrow: other }} title={`其他 ${other}`} />}
      </span>
      {(phase || step) && (
        <span className="agent-summary-progress" role="status" title={[phase, step].filter(Boolean).join(" · ")}>
          {phase && `阶段：${phase}`}
          {phase && step && " · "}
          {step}
        </span>
      )}
    </span>
  );
}

/** Compact in-conversation status, backed by the same agent list as the panel. */
export function AgentStatusIndicator({
  agents,
  onOpen,
}: {
  agents: AgentSummary[];
  /** Called with an agent id when a specific child is chosen. */
  onOpen: (agentId?: string) => void;
}) {
  if (agents.length === 0) return null;
  const { running, waiting, completed, failed, cancelled, phase, step } = summarizeAgents(agents);
  const progress = [phase, step].filter(Boolean).join(" · ");
  const label = `子任务：${running} 个执行中，${waiting} 个等待，${failed} 个异常`
    + (completed ? `，${completed} 个已完成` : "")
    + (cancelled ? `，${cancelled} 个已取消` : "");
  const ordered = orderAgentsForSummary(agents);
  // Like ChatGPT: name up to three children, or two plus "另外 N 个".
  const namedCount = ordered.length > 3 ? 2 : ordered.length;
  const named = ordered.slice(0, namedCount);
  const hidden = ordered.length - namedCount;
  const verb = running > 0
    ? "正在执行"
    : waiting > 0
      ? "等待中"
      : failed > 0
        ? "已结束，部分异常"
        : completed > 0
          ? "已完成"
          : "已停止";
  return (
    <div className="agent-status-indicator" data-state={running > 0 ? "active" : failed > 0 ? "failed" : "idle"}>
      <span className="agent-avatar-stack">
        {ordered.slice(0, 3).map((agent) => (
          <button
            key={agent.agentId}
            type="button"
            className="agent-avatar-button"
            aria-label={`打开 ${agentDisplayName(agent)} 子任务`}
            title={`${agentDisplayName(agent)}：${agent.description}`}
            onClick={() => onOpen(agent.agentId)}
          >
            <AgentAvatar seed={agent.agentId} name={agentDisplayName(agent)} status={agent.status} />
          </button>
        ))}
      </span>
      <button
        type="button"
        className="agent-status-indicator-main"
        aria-label={label}
        title={`${label}。点击查看执行活动`}
        onClick={() => onOpen()}
      >
        <span className="agent-status-sentence">
          {named.map((agent, index) => (
            <span key={agent.agentId}>
              {index > 0 && (index === named.length - 1 && hidden === 0 ? " 和 " : "、")}
              <span className="agent-status-name" data-tone={agentAvatarTone(agent.agentId)}>{agentDisplayName(agent)}</span>
            </span>
          ))}
          {hidden > 0 && <span className="agent-status-more"> 和另外 {hidden} 个</span>}
          <span className="agent-status-verb"> {verb}</span>
        </span>
        <span className="agent-status-counts">
          {running > 0 && <span className="agent-status-chip running"><LoaderCircle size={12} className="activity-spinner" />{running} 执行中</span>}
          {waiting > 0 && <span className="agent-status-chip waiting"><PauseCircle size={12} />{waiting} 等待</span>}
          {failed > 0 && <span className="agent-status-chip failed"><CircleAlert size={12} />{failed} 异常</span>}
          {completed > 0 && <span className="agent-status-chip completed">{completed} 已完成</span>}
          {cancelled > 0 && <span className="agent-status-chip">{cancelled} 已取消</span>}
        </span>
        {progress && <span className="agent-status-indicator-phase">{progress}</span>}
        <Activity size={13} aria-hidden="true" className="agent-status-open-icon" />
      </button>
    </div>
  );
}
