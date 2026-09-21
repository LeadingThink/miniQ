import type { TurnProgress } from "../types";
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
  const active = agents.filter((agent) => ACTIVE.has(agent.status)).length;
  const completed = agents.filter((agent) => agent.status === "completed").length;
  const failed = agents.filter((agent) => EXCEPTION.has(agent.status)).length;
  const other = Math.max(0, agents.length - active - completed - failed);
  const phase = phaseSummary(agents);
  const step = stepSummary(agents);
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
