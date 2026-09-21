import { useCallback, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ListFilter, Search, X } from "lucide-react";
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

export function handleSidebarNavigation(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!(event.target instanceof HTMLButtonElement)) return;
  if (!event.target.matches(".workspace-select, .session-select")) return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".workspace-select, .session-select"));
  const current = controls.indexOf(event.target);
  let next = current;
  if (event.key === "ArrowDown") next = Math.min(current + 1, controls.length - 1);
  else if (event.key === "ArrowUp") next = Math.max(current - 1, 0);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = controls.length - 1;
  else return;
  event.preventDefault();
  controls[next]?.focus();
}

export function SidebarFilters(props: {
  query: string;
  filter: SidebarFilter;
  counts: Record<SidebarFilter, number>;
  onQuery: (value: string) => void;
  onFilter: (value: SidebarFilter) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const mobile = useMobileSidebarLayout();
  const controlsVisible = mobile || expanded;
  const active = props.query !== "" || props.filter !== "all";
  return (
    <div className="sidebar-filters">
      <div className="sidebar-section sidebar-section-heading">
        <span>项目与会话</span>
        {!mobile && <button type="button" className={`sidebar-filter-toggle ${active ? "active" : ""}`}
          aria-label="筛选项目和会话" aria-expanded={controlsVisible} aria-controls="sidebar-filter-controls"
          title={active ? "筛选已启用，点击调整" : "筛选项目和会话"} onClick={() => setExpanded(!expanded)}>
          <ListFilter size={14} />
        </button>}
      </div>
      {controlsVisible && (
        <div className="sidebar-filter-controls" id="sidebar-filter-controls">
          <div className="sidebar-filter-query">
            <Search size={13} aria-hidden="true" />
            <input aria-label="筛选会话、项目或电脑" placeholder="搜索标题、项目或电脑" value={props.query}
              autoComplete="off" enterKeyHint="search"
              onChange={(event) => props.onQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && mobile && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  event.stopPropagation();
                  props.onQuery("");
                  props.onFilter("all");
                }
              }} />
            {active && <button type="button" aria-label="清除会话筛选" title="清除筛选"
              onClick={() => { props.onQuery(""); props.onFilter("all"); }}><X size={13} /></button>}
          </div>
          <div className="sidebar-filter-options" role="group" aria-label="会话状态筛选">
            {([ ["all", "全部"], ["running", "进行中"], ["waiting", "待确认"], ["unread", "未读"], ["failed", "失败"], ["pinned", "置顶"] ] as const).map(([value, label]) => (
              <button type="button" key={value} aria-label={`${label} ${props.counts[value]}`} aria-pressed={props.filter === value}
                onClick={() => props.onFilter(value)}>{label}<span>{props.counts[value]}</span></button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
