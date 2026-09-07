import { ChevronLeft, ChevronRight, CircleAlert, Focus, Layers } from "lucide-react";
import { useEffect, useId, useState } from "react";
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
  const liveAttention = calls.some(
    (call) => (!call.payloadDeferred || call.live) && (call.status === "failed" || call.status === "waiting_approval"),
  );
  const [open, setOpen] = useState(expanded || liveAttention);
  const [page, setPage] = useState(0);
  const regionId = useId();
  const pageSize = 30;
  const pageCount = Math.max(1, Math.ceil(calls.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const runningIndex = calls.findIndex((call) => ["running", "waiting_approval", "pending"].includes(call.status));
  const failedIndex = calls.findIndex((call) => call.status === "failed");
  const showPage = (index: number) => {
    setOpen(true);
    setPage(Math.floor(index / pageSize));
  };
  useEffect(() => {
    if (liveAttention || expanded) setOpen(true);
  }, [liveAttention, expanded]);
  if (calls.length === 1) return <ToolStep call={calls[0]} onRollback={onRollback} client={client} />;
  return (
    <section className={`tool-group ${counts.attention ? "needs-attention" : ""}`}>
      <button
        className="tool-group-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
      >
        <Layers size={15} />
        <strong>{calls.length} 个执行步骤</strong>
        <span>{counts.completed} 已完成</span>
        {counts.running > 0 && <span className="group-running">{counts.running} 执行中</span>}
        {counts.failed > 0 && <span className="group-failed">{counts.failed} 未成功</span>}
        <ChevronRight size={14} className={open ? "open" : ""} />
      </button>
      {open && (
        <div className="tool-group-body" id={regionId} role="region" aria-label="执行步骤详情">
          <div className="tool-group-jumps">
            <span>
              {currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, calls.length)} / {calls.length}
            </span>
            {runningIndex >= 0 && (
              <button
                type="button"
                className="icon-button"
                title="定位当前步骤"
                aria-label="定位当前步骤"
                onClick={() => showPage(runningIndex)}
              >
                <Focus size={14} />
              </button>
            )}
            {failedIndex >= 0 && (
              <button
                type="button"
                className="icon-button"
                title="定位失败步骤"
                aria-label="定位失败步骤"
                onClick={() => showPage(failedIndex)}
              >
                <CircleAlert size={14} />
              </button>
            )}
          </div>
          {calls.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((call) => (
            <ToolStep key={call.id} call={call} onRollback={onRollback} client={client} />
          ))}
          {pageCount > 1 && (
            <nav className="history-pages" aria-label="执行步骤分页">
              <button
                type="button"
                className="icon-button"
                aria-label="上一页步骤"
                title="上一页步骤"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft size={14} />
              </button>
              <span>
                {currentPage + 1} / {pageCount}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="下一页步骤"
                title="下一页步骤"
                disabled={currentPage + 1 === pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                <ChevronRight size={14} />
              </button>
            </nav>
          )}
        </div>
      )}
    </section>
  );
}
