import { Activity, ChevronDown, Download, LoaderCircle, MoreHorizontal, Search, Share2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TimelineFilter } from "../timelineModel";
import { TimelineFilterSheet } from "./TimelineFilterSheet";
import { Menu, MenuItem } from "./ui/Menu";
import "./TimelineToolbar.css";

const filters = [["all", "全部"], ["answers", "回答"], ["activity", "执行"], ["errors", "异常"]] as const;

export const SESSION_TOOLBAR_ACTION_EVENT = "miniq:session-toolbar-action";
export type SessionToolbarAction = "search" | "share" | "diagnostics" | "summary";
export interface SessionToolbarActionDetail {
  sessionId?: string;
  action: SessionToolbarAction;
}

export function dispatchSessionToolbarAction(
  sessionId: string | undefined,
  action: SessionToolbarAction,
) {
  window.dispatchEvent(
    new CustomEvent<SessionToolbarActionDetail>(SESSION_TOOLBAR_ACTION_EVENT, {
      detail: { sessionId, action },
    }),
  );
}

export function TimelineToolbar(props: {
  sessionId?: string;
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
  /** Session context summary, placed before the more-actions menu. */
  summary?: ReactNode;
  /** Enter steps to an older match; Shift+Enter steps to a newer one. */
  onStep?: (direction: -1 | 1) => void;
  /** Phones open the immersive search page instead of the inline field. */
  onSearchOpen?: () => void;
}) {
  const menu = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // 搜索是独立状态：切换「回答/执行/异常」筛选不再顺带撑开搜索框。
  const [searching, setSearching] = useState(false);
  const expanded = searching || !!props.query;
  useEffect(() => {
    if (searching) search.current?.focus();
  }, [searching]);
  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<SessionToolbarActionDetail>).detail;
      if (!detail || detail.action !== "search") return;
      if (props.sessionId && detail.sessionId && detail.sessionId !== props.sessionId) return;
      if (props.onSearchOpen) { props.onSearchOpen(); return; }
      setSearching((current) => {
        const next = !current;
        if (next) window.requestAnimationFrame(() => search.current?.focus());
        return next;
      });
    };
    window.addEventListener(SESSION_TOOLBAR_ACTION_EVENT, onAction);
    return () => window.removeEventListener(SESSION_TOOLBAR_ACTION_EVENT, onAction);
  }, [props.onSearchOpen, props.sessionId]);
  const [filterOpen, setFilterOpen] = useState(false);
  const closeMenu = useCallback(() => setOpen(false), []);
  return (
    <div
      className="timeline-toolbar conversation-tools"
      aria-label="会话记录工具栏"
      data-search-open={expanded ? "true" : "false"}
      onBlur={(event) => {
        if (!filterOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSearching(false);
      }}
    >
      <button type="button" className="icon-button timeline-search-toggle" aria-label="搜索和筛选会话" title="搜索和筛选会话" aria-expanded={expanded} onClick={() => { if (props.onSearchOpen) props.onSearchOpen(); else setSearching(true); }}>
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
        <input ref={search} type="search" aria-label="搜索当前会话" placeholder="搜索会话" data-session-search="true" title="搜索当前会话（⌘/Option+F 或 Ctrl+F）" value={props.query} onChange={(event) => props.onQuery(event.target.value)} onFocus={() => setSearching(true)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && props.onStep) {
            event.preventDefault();
            props.onStep(event.shiftKey ? 1 : -1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onQuery("");
            setSearching(false);
          }
        }} />
        {props.query ? (
          <button type="button" className="icon-button" title="清空搜索" aria-label="清空会话搜索" onClick={() => props.onQuery("")}><X size={14} /></button>
        ) : expanded ? (
          <button
            type="button"
            className="icon-button timeline-search-close"
            title="收起搜索（Esc）"
            aria-label="收起搜索"
            onClick={() => setSearching(false)}
          >
            <X size={14} />
          </button>
        ) : null}
      </label>
      {expanded && props.navigator}
      {props.summary}
      <div className="timeline-actions">
        <button ref={menu} type="button" className="timeline-actions-trigger" title="更多会话操作" aria-label="更多会话操作" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          {props.exporting ? <LoaderCircle size={18} className="activity-spinner" /> : <MoreHorizontal size={18} />}
        </button>
        <Menu open={open} anchorRef={menu} onClose={closeMenu} label="更多会话操作" className="timeline-action-list">
          {props.onShare && <MenuItem icon={<Share2 size={16} />} onClick={props.onShare}>分享会话</MenuItem>}
          {props.onDiagnostics && <MenuItem icon={<Activity size={16} />} onClick={props.onDiagnostics}>模型调用记录</MenuItem>}
          {(["md", "json"] as const).map((format) => <MenuItem key={format} disabled={props.exporting} icon={<Download size={16} />} onClick={() => props.onExport(format)}>导出 {format === "md" ? "Markdown" : "JSON"}</MenuItem>)}
        </Menu>
      </div>
    </div>
  );
}
