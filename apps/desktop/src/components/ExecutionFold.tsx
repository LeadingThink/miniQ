import { ChevronRight, CircleAlert, Layers } from "lucide-react";
import { createContext, useId, useState, type ReactNode } from "react";
import type { ToolCall, TurnTiming } from "../types";
import { compactDuration, executionSummary } from "../timelineTurns";
import { LiveElapsed } from "./LiveElapsed";
import { TurnTimingDetails } from "./TurnTimingDetails";

/** True for content rendered inside an ExecutionFold, whose header already
 * summarises the steps; nested groups skip their own header. */
export const InsideExecutionFold = createContext(false);

/** One collapsible row per turn that stands in for every tool call, plan step
 * and intermediate note. Its header is the turn's only duration display:
 * "用时 xx" when finished, a live clock while this turn runs. Details open
 * only when the user clicks the summary. */
export function ExecutionFold({
  calls,
  timing,
  active,
  attention = false,
  children,
}: {
  calls: ToolCall[];
  timing?: TurnTiming;
  /** This is the turn the agent is currently working on. */
  active: boolean;
  /** Pending approval or question on this turn. */
  attention?: boolean;
  children: ReactNode;
}) {
  const data = executionSummary(calls, timing);
  const running = active && data.running;
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const parts = [running
    ? `执行记录 · ${calls.filter((call) => call.status === "succeeded" && call.toolName !== "task_update").length} 项已完成`
    : `已执行 ${data.steps} 项操作`];
  if (active && data.waitingApproval) parts.push("等待确认");
  else if (active && attention) parts.push("等待回复");
  if (data.failed) parts.push(`${data.failed} 项操作失败`);
  if (data.filesChanged) parts.push(`修改 ${data.filesChanged} 个文件`);
  if (!running && data.durationMs !== undefined) parts.push(`用时 ${compactDuration(data.durationMs)}`);
  const liveStartedAt = running && timing?.status === "running" ? timing.startedAt : undefined;
  const state = data.failed || data.status === "failed" ? "failed" : running ? "running"
    : data.status === "cancelled" ? "cancelled" : "done";
  return (
    <section className={`execution-fold is-${state}${open ? " is-open" : ""}`} data-execution-fold="">
      <button
        type="button"
        className="execution-fold-toggle"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
      >
        <span className="execution-fold-icon" aria-hidden="true">
          {data.failed || state === "failed" ? <CircleAlert size={14} /> : <Layers size={14} />}
        </span>
        <span className="execution-fold-label">
          {parts.join(" · ")}
          {liveStartedAt && <> · <LiveElapsed startedAt={liveStartedAt} prefix="用时" format={compactDuration} /></>}
        </span>
        {state === "cancelled" && !running && <span className="execution-fold-tag">已停止</span>}
        <ChevronRight size={14} className="execution-fold-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="execution-fold-body" id={regionId} role="region" aria-label="当前阶段的执行详情">
          <InsideExecutionFold.Provider value={true}>{children}</InsideExecutionFold.Provider>
          {timing && <TurnTimingDetails timing={timing} />}
        </div>
      )}
    </section>
  );
}
