import { ChevronLeft, ChevronRight, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import type { ToolCall } from "../types";
import { toolCounts } from "../timelineModel";
import { ToolStep } from "./ExecutionActivity";
import type { RpcClient } from "../rpc";

export function ToolGroup({
  calls,
  onRollback,
  expanded = false,
  client,
}: {
  calls: ToolCall[];
  onRollback: (id: string) => void;
  expanded?: boolean;
  client?: RpcClient;
}) {
  const counts = toolCounts(calls);
  const liveAttention = calls.some((call) => (!call.payloadDeferred || call.live) && (call.status === "failed" || call.status === "waiting_approval"));
  const [open, setOpen] = useState(expanded || liveAttention);
  const [page, setPage] = useState(0);
  const pageSize = 30;
  const pageCount = Math.max(1, Math.ceil(calls.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (liveAttention || expanded) setOpen(true);
  }, [liveAttention, expanded]);
  if (calls.length === 1)
    return <ToolStep call={calls[0]} onRollback={onRollback} client={client} />;
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
          {calls.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((call) => (
            <ToolStep key={call.id} call={call} onRollback={onRollback} client={client} />
          ))}
          {pageCount > 1 && <nav className="history-pages" aria-label="执行步骤分页">
            <button type="button" className="icon-button" aria-label="上一页步骤" title="上一页步骤" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></button>
            <span>{currentPage + 1} / {pageCount}</span>
            <button type="button" className="icon-button" aria-label="下一页步骤" title="下一页步骤" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></button>
          </nav>}
        </div>
      )}
    </section>
  );
}
