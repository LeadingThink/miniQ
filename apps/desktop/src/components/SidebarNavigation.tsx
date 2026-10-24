import { useCallback, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { CheckCheck, ChevronsDownUp, ListFilter, Search, X } from "lucide-react";
import { isSessionRunning } from "../sessionStatus";
import { isMobileLayout, MOBILE_LAYOUT_QUERY } from "../mobileViewport";
import type { Session, Workspace } from "../types";

export type SidebarFilter = "all" | "running" | "waiting" | "unread" | "failed" | "pinned";

function subscribeMobileLayout(onChange: () => void) {
  const query = window.matchMedia?.(MOBILE_LAYOUT_QUERY);
  if (query) {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function useMobileSidebarLayout() {
  return useSyncExternalStore(subscribeMobileLayout, isMobileLayout, () => false);
}

export function sidebarGroups(
  workspaces: Workspace[],
  sessions: Session[],
  unread: ReadonlySet<string>,
  query: string,
  filter: SidebarFilter,
  hostLabels: ReadonlyMap<string, string> = new Map(),
) {
  const normalized = query.trim().toLocaleLowerCase();
  const grouped = new Map<string, Session[]>();
  const archived: Session[] = [];
  const counts = { all: 0, running: 0, waiting: 0, unread: 0, failed: 0, pinned: 0 };
  const matchingWorkspaceIds = new Set(workspaces.filter((workspace) =>
    [workspace.name, workspace.path, ...workspace.additionalPaths, hostLabels.get(workspace.id) ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(normalized))).map((workspace) => workspace.id));
  for (const session of sessions) {
    if (!session.archived) {
      counts.all += 1;
      if (isSessionRunning(session.status)) counts.running += 1;
      if (session.status === "waiting_approval") counts.waiting += 1;
      if (session.status === "failed") counts.failed += 1;
      if (unread.has(session.id)) counts.unread += 1;
      if (session.pinned) counts.pinned += 1;
    }
    if (normalized && !matchingWorkspaceIds.has(session.workspaceId) && !session.title.toLocaleLowerCase().includes(normalized)) continue;
    if (filter === "running" && !isSessionRunning(session.status)) continue;
    if (filter === "waiting" && session.status !== "waiting_approval") continue;
    if (filter === "failed" && session.status !== "failed") continue;
    if (filter === "unread" && !unread.has(session.id)) continue;
    if (filter === "pinned" && !session.pinned) continue;
    if (session.archived) {
      if (filter === "all") archived.push(session);
      continue;
    }
    const items = grouped.get(session.workspaceId) ?? [];
    items.push(session);
    grouped.set(session.workspaceId, items);
  }
  const filtering = Boolean(normalized) || filter !== "all";
  const groups = workspaces.flatMap((workspace) => {
    const items = grouped.get(workspace.id) ?? [];
    if (filtering && !items.length && !(filter === "all" && matchingWorkspaceIds.has(workspace.id))) return [];
    return [{ workspace, sessions: items }];
  });
  return { groups, archived, counts, filtering };
}

/** The unified sidebar supplies a [hostId, workspaceId] key so identical IDs
 * on two computers retain independent disclosure preferences. */
export function useProjectDisclosure(workspaceId: string) {
  const key = `miniq.sidebar.project.${workspaceId}.collapsed`;
  const [open, setOpen] = useState(() => {
    try { return window.localStorage.getItem(key) !== "true"; }
    catch { return true; }
  });
  const update = useCallback((next: boolean) => {
    setOpen(next);
    try {
      if (next) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, "true");
    } catch { /* Navigation remains usable when browser storage is unavailable. */ }
  }, [key]);
  return [open, update] as const;
}

type SidebarListNavigation = { count: number; focus: (index: number) => void };
const sidebarLists = new WeakMap<HTMLElement, SidebarListNavigation>();

export function registerSidebarList(element: HTMLElement, navigation: SidebarListNavigation) {
  sidebarLists.set(element, navigation);
  return () => { sidebarLists.delete(element); };
}

/** Navigate the complete data order, including rows outside the DOM window. */
export function handleSidebarNavigation(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.matches(".workspace-select, .session-select")) return;
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const segments = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".workspace-select, [data-sidebar-session-list]"));
  const owner = target.closest<HTMLElement>("[data-sidebar-session-list]") ?? target;
  let current = 0, total = 0;
  for (const element of segments) {
    if (element === owner) current = total + Number(target.closest<HTMLElement>("[data-index]")?.dataset.index ?? 0);
    total += sidebarLists.get(element)?.count ?? 1;
  }
  let next = event.key === "Home" ? 0 : event.key === "End" ? total - 1
    : Math.max(0, Math.min(total - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  event.preventDefault();
  for (const element of segments) {
    const list = sidebarLists.get(element), size = list?.count ?? 1;
    if (next < size) {
      if (list) list.focus(next); else element.focus();
      return;
    }
    next -= size;
  }
}

export function SidebarFilters(props: {
  query: string;
  filter: SidebarFilter;
  counts: Record<SidebarFilter, number>;
  workspaceCount?: number;
  showQuery?: boolean;
  onQuery: (value: string) => void;
  onFilter: (value: SidebarFilter) => void;
  onMarkAllRead?: () => void;
  onCollapseAll?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const mobile = useMobileSidebarLayout();
  const controlsVisible = expanded;
  const active = props.query !== "" || props.filter !== "all";
  const showQuery = props.showQuery ?? true;
  return (
    <div className="sidebar-filters">
      <div className="sidebar-section sidebar-section-heading">
        <span className="sidebar-section-title">工作区与项目</span>
        {typeof props.workspaceCount === "number" && <span className="sidebar-section-count">{props.workspaceCount}</span>}
        {props.onCollapseAll && <button type="button" className="sidebar-collapse-all" aria-label="全部折叠" title="全部折叠" onClick={props.onCollapseAll}>
          <span>全部折叠</span><ChevronsDownUp size={14} aria-hidden="true" />
        </button>}
        {props.onMarkAllRead && props.counts.unread > 0 && <button type="button" className="sidebar-filter-toggle sidebar-mark-all-read"
          aria-label="全部标为已读" title="全部标为已读（⇧Esc）" onClick={props.onMarkAllRead}>
          <CheckCheck size={14} />
        </button>}
        <button type="button" className={`sidebar-filter-toggle ${active ? "active" : ""}`}
          aria-label={mobile ? "更多会话筛选" : "筛选项目和会话"} aria-expanded={controlsVisible} aria-controls="sidebar-filter-controls"
          title={active ? "筛选已启用，点击调整" : "筛选项目和会话"} onClick={() => setExpanded(!expanded)}>
          <ListFilter size={14} />
        </button>
      </div>
      {controlsVisible && (
        <div className="sidebar-filter-controls" id="sidebar-filter-controls">
          {showQuery && <SidebarSearchField query={props.query} active={active} onQuery={props.onQuery}
            onClear={() => { props.onQuery(""); props.onFilter("all"); }} placeholder="搜索标题、项目或电脑" mobile={mobile} />}
          <div className="sidebar-filter-options" role="group" aria-label="会话状态筛选">
            {([ ["all", "全部"], ["running", "进行中"], ["waiting", "待确认"], ["unread", "未读"], ["failed", "失败"], ["pinned", "置顶"] ] as const).filter(([value]) => !mobile || value !== "all" && value !== "running").map(([value, label]) => (
              <button type="button" key={value} aria-label={`${label} ${props.counts[value]}`} aria-pressed={props.filter === value}
                onClick={() => props.onFilter(mobile && props.filter === value ? "all" : value)}>{label}<span>{props.counts[value]}</span></button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function SidebarSearchField(props: {
  query: string;
  active: boolean;
  placeholder: string;
  mobile?: boolean;
  onQuery: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="sidebar-filter-query">
      <Search size={13} aria-hidden="true" />
      <input aria-label="筛选会话、项目或电脑" placeholder={props.placeholder} value={props.query}
        autoComplete="off" enterKeyHint="search"
        onChange={(event) => props.onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && props.mobile && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.stopPropagation();
            props.onClear();
          }
        }} />
      {props.active && <button type="button" aria-label="清除会话筛选" title="清除筛选" onClick={props.onClear}><X size={13} /></button>}
    </div>
  );
}
