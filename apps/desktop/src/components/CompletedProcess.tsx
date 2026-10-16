import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { TurnTiming } from "../types";
import { compactDuration } from "../timelineTurns";
import { TurnTimingDetails } from "./TurnTimingDetails";
import "./CompletedProcess.css";

/** Folds process records; settled turns pass timing, running turns a summary. The answer is never its child. */
export function CompletedProcess({ timing, summary, recordKeys, children }: {
  timing?: TurnTiming;
  summary?: string;
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
    <summary>{summary ?? `${duration ? `已工作 ${duration}` : "工作过程"}${outcome}`}
      <ChevronDown className="completed-process-chevron" size={13} aria-hidden="true" /></summary>
    {open && <div className="completed-process-body" data-lazy-body="">
      {typeof children === "function" ? children() : children}
      {timing && !summary && <TurnTimingDetails timing={timing} />}
    </div>}
  </details>;
}
