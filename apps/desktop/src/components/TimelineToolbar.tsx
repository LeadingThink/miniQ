import { Activity, ChevronDown, Download, LoaderCircle, MoreHorizontal, Search, Share2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TimelineFilter } from "../timelineModel";
import { TimelineFilterSheet } from "./TimelineFilterSheet";
import "./TimelineToolbar.css";

const filters = [["all", "全部"], ["answers", "回答"], ["activity", "执行"], ["errors", "异常"]] as const;

export function TimelineToolbar(props: {
  filter: TimelineFilter;
  query: string;
  exporting: boolean;
  filterCounts?: Record<TimelineFilter, number>;
  onFilter: (filter: TimelineFilter) => void;
  onQuery: (query: string) => void;
  onShare?: () => void;
  onDiagnostics?: () => void;
  onExport: (format: "md" | "json") => void;
  /** Result counter and stepping controls, shown while searching. */
  navigator?: ReactNode;
  /** Enter steps to an older match; Shift+Enter steps to a newer one. */
  onStep?: (direction: -1 | 1) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // Phones collapse filter + search behind one icon until needed. An active
  // query or filter keeps them expanded so the user can see why rows are hidden.
  const [searching, setSearching] = useState(false);
  const expanded = searching || !!props.query || props.filter !== "all";
  useEffect(() => {
    if (searching) search.current?.focus();
  }, [searching]);
  const [filterOpen, setFilterOpen] = useState(false);
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
    <div
      className="timeline-toolbar conversation-tools"
      aria-label="会话记录工具栏"
      data-search-open={expanded ? "true" : "false"}
      onBlur={(event) => {
        if (!filterOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSearching(false);
      }}
    >
      <button type="button" className="icon-button timeline-search-toggle" aria-label="搜索和筛选会话" title="搜索和筛选会话" aria-expanded={expanded} onClick={() => setSearching(true)}>
        <Search size={18} />
      </button>
      <div className="timeline-modes" role="group" aria-label="记录类型">
        {filters.map(([value, label]) => <button type="button" key={value} aria-pressed={props.filter === value} onClick={() => props.onFilter(value)}>{label}</button>)}
      </div>
      <button type="button" className="timeline-mobile-filter" aria-label="筛选会话记录" aria-haspopup="dialog" aria-expanded={filterOpen} onClick={() => setFilterOpen(true)}>
        <span>{filters.find(([value]) => value === props.filter)?.[1]}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <TimelineFilterSheet open={filterOpen} filter={props.filter} counts={props.filterCounts} onClose={() => setFilterOpen(false)} onFilter={props.onFilter} />
      <label className="timeline-search">
        <Search size={14} aria-hidden="true" />
        <input ref={search} type="search" aria-label="搜索当前会话" placeholder="搜索会话" data-session-search="true" title="搜索当前会话（⌘/Option+F 或 Ctrl+F）" value={props.query} onChange={(event) => props.onQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && props.onStep) {
            event.preventDefault();
            props.onStep(event.shiftKey ? 1 : -1);
          } else if (event.key === "Escape" && props.query) {
            event.preventDefault();
            props.onQuery("");
          }
        }} />
        {props.query && <button type="button" className="icon-button" title="清空会话搜索" aria-label="清空会话搜索" onClick={() => props.onQuery("")}><X size={14} /></button>}
      </label>
      {props.navigator}
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
