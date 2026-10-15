import { Check, ChevronRight, CircleDot, CircleX } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import { formatDuration } from "../time";
import { ToolStep, toolActionLabel, toolInputSummary } from "./ExecutionActivity";
import { LiveElapsed } from "./LiveElapsed";
import "./ToolRunRow.css";
import { isActiveCall, toolRunSummary, toolStepTitle, type ToolRun } from "./toolSummary";

const FAILED = new Set(["failed", "rejected", "cancelled"]);

function runDuration(calls: ToolCall[]): string | null {
  const ends = calls.map((call) => call.completedAt).filter((value): value is string => Boolean(value));
  if (ends.length !== calls.length) return null;
  const start = Math.min(...calls.map((call) => Date.parse(call.createdAt)));
  const end = Math.max(...ends.map((value) => Date.parse(value)));
  return formatDuration(end - start);
}

/** Compact adjacent activity; all original steps remain available on expansion. */
export function ToolRunRow({ run, onRollback, client, focusId, stepExpanded, expanded = false }: {
  expanded?: boolean;
  run: ToolRun;
  onRollback?: (checkpointId: string) => void;
  client?: RpcClient;
  focusId: string | null;
  stepExpanded: (call: ToolCall) => boolean;
}) {
  const active = run.calls.find(isActiveCall);
  const focused = run.calls.some((call) => call.id === focusId);
  const [open, setOpen] = useState(expanded || focused);
  const regionId = useId();
  useEffect(() => {
    if (focused || expanded) setOpen(true);
  }, [focused, expanded]);
  const summary = toolRunSummary(run);
  const failed = run.calls.filter((call) => FAILED.has(call.status)).length;
  const activeTitle = active ? toolStepTitle(active, true) : null;
  const animating = run.calls.some(call => call.status === "running" || call.status === "pending");
  const exploring = ["read", "list", "codeSearch", "exploration"].includes(run.kind ?? "");
  const label = exploring
    ? (animating ? "正在探索" : active ? "探索等待确认" : "已探索")
    : active ? (activeTitle?.verb ?? toolActionLabel(active.toolName, true, active.input)) : summary;
  const target = active ? (activeTitle?.target ?? toolInputSummary(active)) : "";
  const status = active ? "running" : failed ? "failed" : "succeeded";
  const duration = active ? null : runDuration(run.calls);
  return (
    <div className={`tool-step tool-run ${status}`} aria-live={active ? "polite" : undefined}>
      <div className="tool-step-head">
        <button
          type="button"
          className="tool-step-toggle"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen(!open)}
        >
          <span className="tool-step-marker" aria-hidden="true">
            {active ? <CircleDot size={15} /> : failed ? <CircleX size={14} /> : <Check size={14} />}
          </span>
          <span className={`tool-action${animating ? " tool-run-shimmer" : ""}`}>{label}</span>
          {exploring && <span className="tool-run-summary">{summary}</span>}
          {target && <span className="tool-summary" title={target}>{target}</span>}
          <span className="tool-run-count">{run.calls.length} 步</span>
          {active?.status === "waiting_approval" && (
            <span className="tool-step-state waiting_approval">等待确认</span>
          )}
          {failed > 0 && <span className="tool-step-state failed">{failed} 项未成功</span>}
          {active ? (
            <LiveElapsed startedAt={active.createdAt} className="tool-duration" />
          ) : (
            duration && <span className="tool-duration">{duration}</span>
          )}
          <ChevronRight className={`chevron ${open ? "open" : ""}`} size={14} />
        </button>
      </div>
      {open && (
        <div className="tool-run-steps" id={regionId} role="region" aria-label={`${summary}的步骤`}>
          {run.calls.map((call) => (
            <div key={call.id} data-history-anchor={`tool:${call.id}`} data-search-records={`tool:${call.id}`}>
              <ToolStep
                call={call}
                onRollback={onRollback}
                client={client}
                defaultExpanded={stepExpanded(call)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
