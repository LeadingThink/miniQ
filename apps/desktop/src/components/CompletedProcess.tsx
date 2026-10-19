import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../errorMessage";
import { failedCount, type FoldRecords } from "../processRecords";
import type { ProcessSummary, TurnTiming } from "../types";
import { compactDuration } from "../timelineTurns";
import { TurnTimingDetails } from "./TurnTimingDetails";
import { Spinner } from "./ui/Spinner";
import "./CompletedProcess.css";

function foldMeta(stats: ProcessSummary): string {
  const failed = failedCount(stats);
  return ` · ${stats.recordCount} 条记录${failed ? ` · ${failed} 个失败` : ""}`;
}

/** Folds process records; settled turns pass timing, running turns a summary. The answer is never its child.
 * `stats` and `records` describe a fold whose records load when it first opens. */
export function CompletedProcess({ timing, summary, stats, records, locateKey, onLocated, recordKeys, children }: {
  timing?: TurnTiming;
  summary?: string;
  stats?: ProcessSummary;
  records?: FoldRecords;
  /** Open and load pages until this record is present, then call `onLocated`. */
  locateKey?: string;
  onLocated?: () => void;
  recordKeys: string;
  children: ReactNode | (() => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const [fetch, setFetch] = useState<{ loading: boolean; error?: string }>({ loading: false });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const load = records?.load;
  const run = useCallback(async () => {
    if (!load) return;
    setFetch({ loading: true });
    const result = await load();
    if (mounted.current) setFetch({ loading: false, error: result && "error" in result ? errorMessage(result.error) : undefined });
  }, [load]);

  const located = locateKey !== undefined && recordKeys.split(" ").includes(locateKey);
  const locating = locateKey !== undefined && !located;
  useEffect(() => {
    if (locateKey === undefined || open) return;
    if (details.current) details.current.open = true;
    setOpen(true);
  }, [locateKey, open]);
  const needsRecords = Boolean(records) && !records!.complete && (locating || (open && records!.loaded === 0));
  useEffect(() => {
    if (needsRecords && !fetch.loading && !fetch.error) void run();
  }, [needsRecords, fetch.loading, fetch.error, run, records?.loaded]);
  useEffect(() => {
    if (locateKey === undefined) return;
    if (located || records?.complete || fetch.error) onLocated?.();
  }, [locateKey, located, records?.complete, fetch.error, onLocated]);

  const elapsed = timing?.elapsedMs ?? (timing?.completedAt
    ? Date.parse(timing.completedAt) - Date.parse(timing.startedAt) : undefined);
  const duration = elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0
    ? compactDuration(elapsed) : undefined;
  const outcome = timing?.status === "failed" ? " · 未完成"
    : timing?.status === "cancelled" || timing?.status === "interrupted" ? " · 已停止" : "";
  const total = records ? Math.max(records.total, records.loaded) : 0;
  const progress = records ? `已加载 ${records.loaded} / 共 ${total}` : "";
  return <details ref={details} className="completed-process" data-search-records={recordKeys}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{summary ?? `${duration ? `已工作 ${duration}` : "工作过程"}${outcome}`}
      {stats && <span className="completed-process-meta">{foldMeta(stats)}</span>}
      <ChevronDown className="completed-process-chevron" size={13} aria-hidden="true" /></summary>
    {open && <div className="completed-process-body" data-lazy-body="">
      {records && !records.complete && (fetch.error
        ? <div className="completed-process-status" role="alert">
          加载工作过程失败：{fetch.error}（{progress}）
          <button type="button" className="ghost" onClick={() => void run()}>重试</button>
        </div>
        : fetch.loading || records.loaded === 0
          ? <div className="completed-process-status" role="status">
            <Spinner size={13} />正在加载工作过程… {progress}
          </div>
          : <div className="completed-process-status">
            <button type="button" className="ghost" onClick={() => void run()}>
              加载更早的记录（{progress}）
            </button>
          </div>)}
      {typeof children === "function" ? children() : children}
      {timing && !summary && <TurnTimingDetails timing={timing} />}
    </div>}
  </details>;
}
