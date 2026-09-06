import { ChevronRight, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import type { ToolCall } from "../types";
import { toolCounts } from "../timelineModel";
import { ToolStep } from "./ExecutionActivity";

export function ToolGroup({
  calls,
  onRollback,
  expanded = false,
}: {
  calls: ToolCall[];
  onRollback: (id: string) => void;
  expanded?: boolean;
}) {
  const counts = toolCounts(calls);
  const [open, setOpen] = useState(expanded || counts.attention);
  useEffect(() => {
    if (counts.attention || expanded) setOpen(true);
  }, [counts.attention, expanded]);
  if (calls.length === 1)
    return <ToolStep call={calls[0]} onRollback={onRollback} />;
  return (
    <section
      className={`tool-group ${counts.attention ? "needs-attention" : ""}`}
    >
      <button
        className="tool-group-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Layers size={15} />
        <strong>{calls.length} 个执行步骤</strong>
        <span>{counts.completed} 已完成</span>
        {counts.running > 0 && (
          <span className="group-running">{counts.running} 执行中</span>
        )}
        {counts.failed > 0 && (
          <span className="group-failed">{counts.failed} 未成功</span>
        )}
        <ChevronRight size={14} className={open ? "open" : ""} />
      </button>
      {open && (
        <div className="tool-group-body">
          {calls.map((call) => (
            <ToolStep key={call.id} call={call} onRollback={onRollback} />
          ))}
        </div>
      )}
    </section>
  );
}
