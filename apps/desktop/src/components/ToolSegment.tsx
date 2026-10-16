import { ChevronDown, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import { ToolStep, toolActionLabel, toolInputSummary } from "./ExecutionActivity";
import { ToolRunRow } from "./ToolRunRow";
import { isActiveCall, toolRuns, toolSegmentSummary, toolStepTitle } from "./toolSummary";
import "./ToolSegment.css";

const FAILED = new Set(["failed", "rejected", "cancelled"]);

/** A contiguous run of tool calls as one quiet line; steps mount only when opened. */
export function ToolSegment({ calls, expanded, client, onRollback }: {
  calls: ToolCall[];
  expanded: boolean;
  client?: RpcClient;
  onRollback?: (checkpointId: string) => void;
}) {
  const [open, setOpen] = useState(expanded);
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);
  const active = [...calls].reverse().find(isActiveCall);
  const failed = calls.filter((call) => FAILED.has(call.status)).length;
  const title = active ? toolStepTitle(active, true) : null;
  const label = active
    ? `${title?.verb ?? toolActionLabel(active.toolName, true, active.input)} ${title?.target ?? toolInputSummary(active)}`.trim()
    : toolSegmentSummary(calls);
  const waiting = active?.status === "waiting_approval";
  return <details className={`tool-segment${active ? " active" : ""}`} open={open}
    data-history-anchor={`tool:${calls[0].id}`}
    data-search-records={calls.map((call) => `tool:${call.id}`).join(" ")}
    aria-live={active ? "polite" : undefined}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <SquareTerminal size={14} aria-hidden="true" />
      <span className={`tool-segment-label${active && !waiting ? " tool-run-shimmer" : ""}`} title={label}>{label}</span>
      {waiting && <span className="tool-segment-state">等待确认</span>}
      {failed > 0 && <span className="tool-segment-state failed">{failed} 项未成功</span>}
      <ChevronDown className="tool-segment-chevron" size={13} aria-hidden="true" />
    </summary>
    {open && <div className="tool-segment-body" data-lazy-body="">
      {toolRuns(calls).map((run, index) => <div key={run.calls[0].id}
        data-history-anchor={index > 0 ? `tool:${run.calls[0].id}` : undefined}
        data-search-records={run.calls.map((call) => `tool:${call.id}`).join(" ")}>
        {run.calls.length === 1
          ? <ToolStep call={run.calls[0]} onRollback={onRollback} defaultExpanded={expanded} client={client} />
          : <ToolRunRow run={run} onRollback={onRollback} client={client}
              expanded={expanded} focusId={null} stepExpanded={() => expanded} />}
      </div>)}
    </div>}
  </details>;
}
