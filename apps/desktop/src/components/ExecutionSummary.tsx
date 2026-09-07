import { Check, CirclePause, CircleX, LoaderCircle, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import { useMemo } from "react";
import { currentExecution } from "../timelineModel";
import type { Message, PlanTask, ToolCall, TurnProgress } from "../types";
import { toolActionLabel, toolInputSummary, turnProgressLabel } from "./ExecutionActivity";
import "./ExecutionSummary.css";

export function ExecutionSummary(props: {
  messages: Message[];
  calls: ToolCall[];
  progress: TurnProgress | null;
  plan: PlanTask[];
  busy: boolean;
  approvals: number;
  questions: number;
}) {
  const summary = useMemo(() => currentExecution(props.messages, props.calls), [props.messages, props.calls]);
  if (!props.busy && !summary.completed && !summary.failed && !summary.cancelled) return null;
  const active = props.busy ? summary.running.at(-1) : undefined;
  const label = props.approvals
    ? "等待操作确认"
    : props.questions
      ? "等待你的回答"
      : active
        ? toolActionLabel(active.toolName, true)
        : props.busy
          ? turnProgressLabel(props.progress)
          : "本轮执行记录";
  const Icon = props.approvals
    ? ShieldQuestion
    : props.questions
      ? MessageCircleQuestion
      : props.busy
        ? LoaderCircle
        : summary.failed
          ? CircleX
          : Check;
  const task = props.busy ? props.plan.find((task) => task.status === "in_progress") : undefined;
  const detail = task?.content || (active ? toolInputSummary(active) : "");
  return (
    <section className="execution-summary" aria-label="当前执行摘要">
      <div className="execution-summary-title">
        <Icon size={16} className={props.busy && !props.approvals && !props.questions ? "activity-spinner" : ""} />
        <strong role="status">{label}</strong>
        {detail && <span title={detail}>{detail}</span>}
      </div>
      <div className="execution-summary-counts" aria-label={summary.partial ? "已加载步骤统计" : "本轮步骤统计"}>
        {summary.partial && <span>已加载</span>}
        <span>
          <Check size={12} />
          {summary.completed} 完成
        </span>
        {summary.running.length > 0 && props.busy && <span>{summary.running.length} 执行中</span>}
        {summary.waiting > 0 && <span>{summary.waiting} 待确认</span>}
        {summary.failed > 0 && (
          <span className="execution-failed">
            <CircleX size={12} />
            {summary.failed} 失败
          </span>
        )}
        {summary.cancelled > 0 && (
          <span>
            <CirclePause size={12} />
            {summary.cancelled} 取消/拒绝
          </span>
        )}
      </div>
    </section>
  );
}
