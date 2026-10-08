import { ChevronRight, CircleAlert, Layers, LoaderCircle } from "lucide-react";
import { createContext, useId, useState, type ReactNode } from "react";
import type { ToolCall, TurnTiming } from "../types";
import { compactDuration, executionSummary } from "../timelineTurns";
import { toolActionLabel, toolInputSummary } from "./ExecutionActivity";

/** True for content rendered inside an ExecutionFold, whose header already
 * summarises the steps; nested groups skip their own header. */
export const InsideExecutionFold = createContext(false);

function liveStep(calls: ToolCall[]): string | null {
  const call = [...calls].reverse().find((candidate) =>
    ["running", "pending", "waiting_approval"].includes(candidate.status));
  if (!call) return null;
  if (call.status === "waiting_approval") return `等待确认：${toolActionLabel(call.toolName, true, call.input)}`;
  const detail = toolInputSummary(call);
  return detail ? `${toolActionLabel(call.toolName, true, call.input)} · ${detail}` : toolActionLabel(call.toolName, true, call.input);
}

/** One collapsible row per turn that stands in for every tool call, plan step
 * and intermediate note. It opens itself whenever the turn needs the user. */
export function ExecutionFold({
  calls,
  timing,
  active,
  attention = false,
  forceOpen = false,
  children,
}: {
  calls: ToolCall[];
  timing?: TurnTiming;
  /** This is the turn the agent is currently working on. */
  active: boolean;
  /** Pending approval or question on this turn. */
  attention?: boolean;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const data = executionSummary(calls, timing);
  const running = active && data.running;
  const needsUser = attention || data.waitingApproval || data.failed > 0;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = forceOpen || (needsUser && userOpen !== false) || userOpen === true;
  const regionId = useId();
  const current = running ? liveStep(calls) : null;
  const parts = [`已执行 ${data.steps} 项操作`];
  if (data.failed) parts.push(`${data.failed} 项操作失败`);
  if (data.filesChanged) parts.push(`修改 ${data.filesChanged} 个文件`);
  if (!running && data.durationMs !== undefined) parts.push(`总运行时间 ${compactDuration(data.durationMs)}`);
  const state = running ? "running" : data.failed || data.status === "failed" ? "failed"
    : data.status === "cancelled" ? "cancelled" : "done";
  return (
    <section className={`execution-fold is-${state}${open ? " is-open" : ""}`} data-execution-fold="">
      <button
        type="button"
        className="execution-fold-toggle"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setUserOpen(!open)}
      >
        <span className="execution-fold-icon" aria-hidden="true">
          {running ? <LoaderCircle size={14} className="spin" />
            : state === "failed" ? <CircleAlert size={14} /> : <Layers size={14} />}
        </span>
        <span className="execution-fold-label">
          {running ? (current ?? `正在执行 · 已完成 ${calls.filter((call) => call.status === "succeeded").length} 项操作`) : parts.join(" · ")}
        </span>
        {state === "cancelled" && !running && <span className="execution-fold-tag">已停止</span>}
        <ChevronRight size={14} className="execution-fold-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="execution-fold-body" id={regionId} role="region" aria-label="当前阶段的执行详情">
          <InsideExecutionFold.Provider value={true}>{children}</InsideExecutionFold.Provider>
        </div>
      )}
    </section>
  );
}
