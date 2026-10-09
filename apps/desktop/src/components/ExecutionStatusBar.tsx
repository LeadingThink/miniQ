import { ChevronDown, LoaderCircle, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { currentTurnCalls } from "../timelineModel";
import { latestMessageTiming } from "../timelineTiming";
import type { AnchoredTurnTiming, Message, PlanTask, ToolCall, TurnProgress } from "../types";
import { currentPlanStep, planCounts, PlanSteps, toolActionLabel, toolInputSummary, turnProgressLabel } from "./ExecutionActivity";
import { LiveElapsed } from "./LiveElapsed";
import { RetryNotice } from "./RetryNotice";
import "./ExecutionStatusBar.css";

interface ExecutionStatusBarProps {
  messages: Message[];
  calls: ToolCall[];
  progress: TurnProgress | null;
  plan: PlanTask[];
  busy: boolean;
  approvals: number;
  questions: number;
  timing?: AnchoredTurnTiming | null;
}

function activityLabel(props: ExecutionStatusBarProps, active?: ToolCall): string {
  if (props.approvals) return "等待操作确认";
  if (props.questions) return "等待你的回答";
  if (props.progress?.retry) return turnProgressLabel(props.progress);
  return active
    ? toolActionLabel(active.toolName, true, active.input)
    : turnProgressLabel(props.progress);
}

/** The only live task indicator, outside the scrollable transcript. */
export function ExecutionStatusBar(props: ExecutionStatusBarProps) {
  const active = useMemo(() => currentTurnCalls(props.messages, props.calls)
    .filter((call) => call.status === "running" || call.status === "pending").at(-1), [props.messages, props.calls]);
  const [open, setOpen] = useState(false);
  const planId = useId();
  const bar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!props.busy) setOpen(false);
  }, [props.busy]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!bar.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  if (!props.busy) return null;
  const waiting = props.approvals > 0 || props.questions > 0;
  const retry = !waiting && props.progress?.retry;
  const task = props.plan.find((item) => item.status === "in_progress");
  const detail = waiting ? "" : task?.content || (active ? toolInputSummary(active) : "");
  const timing = (props.timing ?? latestMessageTiming(props.messages))?.timing;
  const startedAt = timing?.status === "running" ? timing.startedAt
    : retry ? props.progress?.startedAt : active?.createdAt ?? props.progress?.startedAt;
  const Icon = props.approvals ? ShieldQuestion : props.questions ? MessageCircleQuestion : LoaderCircle;
  const { done, total } = planCounts(props.plan);
  return (
    <section ref={bar} className="execution-status-bar" aria-label="当前任务状态">
      <div className="execution-status-row">
        <Icon size={15} aria-hidden="true" className={waiting ? "" : "activity-spinner"} />
        <strong role="status" aria-live="polite">{activityLabel(props, active)}</strong>
        {!waiting && startedAt && (
          <LiveElapsed startedAt={startedAt} className="execution-status-time"
            prefix={timing?.status === "running" ? "总用时" : active && !retry ? "当前操作" : "当前处理"} />
        )}
        {total > 0 && (
          <button ref={toggle} type="button" className="execution-status-plan-toggle" aria-expanded={open}
            aria-controls={planId} aria-label={`步骤 ${currentPlanStep(props.plan)}/${total}，已完成 ${done} 个步骤`}
            onClick={() => setOpen((value) => !value)}>
            步骤 {currentPlanStep(props.plan)}/{total}
            <ChevronDown size={13} aria-hidden="true" className={open ? "open" : ""} />
          </button>
        )}
      </div>
      {retry && props.progress && <RetryNotice progress={props.progress} />}
      {detail && <p className="execution-status-detail">{detail}</p>}
      {open && total > 0 && (
        <div id={planId} className="execution-status-plan execution-plan" role="region" aria-label="任务步骤详情">
          <PlanSteps plan={props.plan} busy />
        </div>
      )}
    </section>
  );
}
