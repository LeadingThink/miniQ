import { useState, type ReactNode } from "react";
import type { TurnTiming } from "../types";
import { compactDuration } from "../timelineTurns";
import { TurnTimingDetails } from "./TurnTimingDetails";
import "./CompletedProcess.css";

/** Only settled turns use this disclosure. The answer is never its child. */
export function CompletedProcess({ timing, recordKeys, children }: {
  timing?: TurnTiming;
  recordKeys: string;
  children: ReactNode | (() => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const elapsed = timing?.elapsedMs ?? (timing?.completedAt
    ? Date.parse(timing.completedAt) - Date.parse(timing.startedAt) : undefined);
  const duration = elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0
    ? compactDuration(elapsed) : undefined;
  const outcome = timing?.status === "failed" ? " · 未完成"
    : timing?.status === "cancelled" || timing?.status === "interrupted" ? " · 已停止" : "";
  return <details className="completed-process" data-search-records={recordKeys}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{duration ? `已工作 ${duration}` : "工作过程"}{outcome}</summary>
    {open && <div className="completed-process-body">
      {typeof children === "function" ? children() : children}
      {timing && <TurnTimingDetails timing={timing} />}
    </div>}
  </details>;
}
