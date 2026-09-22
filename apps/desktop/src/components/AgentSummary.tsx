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
    (agent) => ["queued", "waiting", "waiting_approval"].includes(agent.status),
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
  onOpen: () => void;
}) {
  if (agents.length === 0) return null;
  const { running, waiting, completed, failed, cancelled, phase, step } = summarizeAgents(agents);
  const progress = [phase, step].filter(Boolean).join(" · ");
  const label = `子任务：${running} 个执行中，${waiting} 个等待，${failed} 个异常`
    + (completed ? `，${completed} 个已完成` : "")
    + (cancelled ? `，${cancelled} 个已取消` : "");
  return (
    <button
      type="button"
      className="agent-status-indicator"
      aria-label={label}
      title={`${label}。点击查看执行活动`}
      onClick={onOpen}
    >
      <Activity size={14} aria-hidden="true" />
      <span className="agent-status-indicator-label">子任务</span>
      {running > 0 && <span className="agent-status-chip running"><LoaderCircle size={12} className="activity-spinner" />{running} 执行中</span>}
      {waiting > 0 && <span className="agent-status-chip waiting"><PauseCircle size={12} />{waiting} 等待</span>}
      {failed > 0 && <span className="agent-status-chip failed"><CircleAlert size={12} />{failed} 异常</span>}
      {completed > 0 && <span className="agent-status-chip completed">{completed} 已完成</span>}
      {cancelled > 0 && <span className="agent-status-chip">{cancelled} 已取消</span>}
      {progress && <span className="agent-status-indicator-phase">{progress}</span>}
    </button>
  );
}
