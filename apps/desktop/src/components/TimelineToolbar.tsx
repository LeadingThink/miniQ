import { Activity, Download, LoaderCircle, MoreHorizontal, Search, Share2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TimelineFilter } from "../timelineModel";
import "./TimelineToolbar.css";

const filters = [["all", "全部"], ["answers", "回答"], ["activity", "执行"], ["errors", "异常"]] as const;

export function TimelineToolbar(props: {
  filter: TimelineFilter;
  query: string;
  exporting: boolean;
  onFilter: (filter: TimelineFilter) => void;
  onQuery: (query: string) => void;
  onShare?: () => void;
  onDiagnostics?: () => void;
  onExport: (format: "md" | "json") => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const run = (action: () => void) => {
    if (menu.current) menu.current.open = false;
    action();
  };
  return (
    <div className="timeline-toolbar conversation-tools" aria-label="会话记录工具栏">
      <div className="timeline-modes" role="group" aria-label="记录类型">
        {filters.map(([value, label]) => <button type="button" key={value} aria-pressed={props.filter === value} onClick={() => props.onFilter(value)}>{label}</button>)}
      </div>
      <select className="timeline-mobile-filter" aria-label="筛选会话记录" value={props.filter} onChange={(event) => props.onFilter(event.target.value as TimelineFilter)}>
        {filters.map(([value, label]) => <option key={value} value={value}>{label}记录</option>)}
      </select>
      <label className="timeline-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" aria-label="搜索当前会话" placeholder="搜索会话" data-session-search="true" title="搜索当前会话（⌘/Option+F 或 Ctrl+F）" value={props.query} onChange={(event) => props.onQuery(event.target.value)} />
        {props.query && <button type="button" className="icon-button" title="清空会话搜索" aria-label="清空会话搜索" onClick={() => props.onQuery("")}><X size={14} /></button>}
      </label>
      <details ref={menu} className="timeline-actions" onToggle={(event) => setOpen(event.currentTarget.open)} onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current?.open) {
          event.preventDefault();
          menu.current.open = false;
          menu.current.querySelector("summary")?.focus();
        }
      }}>
        <summary title="更多会话操作" aria-label="更多会话操作" aria-expanded={open}>
          {props.exporting ? <LoaderCircle size={18} className="activity-spinner" /> : <MoreHorizontal size={18} />}
        </summary>
        <div className="timeline-action-list">
          {props.onShare && <button type="button" onClick={() => run(props.onShare!)}><Share2 size={16} />分享会话</button>}
          {props.onDiagnostics && <button type="button" onClick={() => run(props.onDiagnostics!)}><Activity size={16} />模型调用记录</button>}
          {(["md", "json"] as const).map((format) => <button type="button" key={format} disabled={props.exporting} onClick={() => run(() => props.onExport(format))}><Download size={16} />导出 {format === "md" ? "Markdown" : "JSON"}</button>)}
        </div>
      </details>
    </div>
  );
}
