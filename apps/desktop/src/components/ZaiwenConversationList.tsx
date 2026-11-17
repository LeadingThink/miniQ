import { RefreshCw } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { ZaiwenSession } from "../zaiwenAuth";
import type { ZaiwenHistory } from "../hooks/useZaiwenHistory";
import { zaiwenSessionView } from "../zaiwenSessionView";
import { registerSidebarList, type SidebarFilter } from "./SidebarNavigation";
import { SidebarSessionItem } from "./SidebarSessionItem";
import { EmptyState } from "./ui/EmptyState";
import "./Sidebar.css";
import "./ZaiwenHistory.css";

/** Cloud rows join the existing sidebar; local projects and actions remain available. */
export function ZaiwenConversationList({ session, history, onLogin, onSelect, query, filter }: {
  session: ZaiwenSession | null;
  history: ZaiwenHistory;
  onLogin: () => void;
  onSelect: () => void;
  query: string;
  filter: SidebarFilter;
}) {
  const list = useRef<HTMLDivElement>(null);
  const page = history.conversations;
  const items = page.items.filter((item) => (filter === "all" || (filter === "pinned" && item.pinned)) && (item.title || "未命名会话").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useLayoutEffect(() => {
    const element = list.current!;
    return registerSidebarList(element, { count: items.length, focus: (index) => {
      element.querySelector<HTMLButtonElement>(`[data-index="${index}"] .session-select`)?.focus();
    } });
  }, [items.length]);
  return <>
    <div className="sidebar-section sidebar-section-heading"><span className="sidebar-section-title">最近</span>
      <button type="button" className="icon-button" aria-label="刷新主站会话" disabled={page.loading} onClick={history.refresh}><RefreshCw size={14} /></button>
    </div>
    <div ref={list} data-sidebar-session-list>
      {!session || history.requiresLogin ? <button type="button" className="ghost" onClick={onLogin}>登录在问，查看会话</button> : <>
        {items.map((conversation, index) => <div key={conversation.id} data-index={index}>
          <SidebarSessionItem session={zaiwenSessionView(conversation)}
            current={history.selected?.id === conversation.id} unread={false}
            onSelect={() => { history.select(conversation); onSelect(); }} />
        </div>)}
        {page.loading && <p className="zaiwen-history-notice" role="status">正在加载会话…</p>}
        {page.error && <div className="zaiwen-history-notice" role="alert"><p>{page.error}</p>
          <button type="button" className="ghost" disabled={page.loading} onClick={page.refresh}>重试加载会话</button></div>}
        {!page.loading && !page.error && !items.length && <EmptyState compact className="sidebar-empty"
          title={query || filter !== "all" ? "没有符合条件的主站会话" : "主站还没有会话"} />}
        {page.cursor && <button type="button" className="ghost" disabled={page.loading} onClick={page.loadMore}>加载更多会话</button>}
      </>}
    </div>
  </>;
}
