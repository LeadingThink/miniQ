import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type TouchEvent } from "react";
import {
  FolderPlus,
  Archive,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  MessageSquareText,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  Search,
  SearchX,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import type { CatalogStatus } from "../hostWorkspace";
import type { Session, Workspace } from "../types";
import type { AppUpdaterState } from "../hooks/useAppUpdater";
import { openExternalUrl } from "../externalLinks";
import { UpdateNotice } from "./UpdateNotice";
import { DropdownMenu } from "./DropdownMenu";
import { isTauriRuntime } from "../runtime";
import { EmptyState } from "./ui/EmptyState";
import { SidebarPanel } from "./SidebarPanel";
import { SidebarSessionList } from "./SidebarSessionList";
import { SidebarAttention } from "./SidebarAttention";
import { handleSidebarNavigation, SidebarFilters, SidebarSearchField, sidebarGroups, type SidebarFilter } from "./SidebarNavigation";
import { useMobileLayout } from "../hooks/useMobileLayout";
import { WorkspaceGroup } from "./WorkspaceGroup";
import "./Sidebar.css";

const FEEDBACK_FORM_URL =
  "https://zaiwen-chattests.feishu.cn/share/base/form/shrcncCk7TJ5Jns8e34ycHSD3yf";

export interface SidebarHostGroup {
  key: string;
  label: string;
  state: string;
  error?: string;
  workspaceIds: string[];
  catalogStatus?: CatalogStatus;
  catalogError?: string;
  onRetry?: () => void;
  /** False when this host's workspaces are not on this machine. */
  local?: boolean;
  selected: boolean;
  onSelect: () => void;
}

interface SidebarProps {
  hostGroups?: SidebarHostGroup[];
  onClose?: () => void;
  workspaces: Workspace[];
  sessions: Session[];
  unreadSessionIds: ReadonlySet<string>;
  currentSessionId: string | null;
  selectedWorkspaceId: string | null;
  onNewChat: () => void;
  onShowSearch: () => void;
  onShowSchedule: () => void;
  onImportSessions: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateSession: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onEditWorkspace: (workspaceId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSessionSeen: (sessionId: string) => void;
  onSessionUnread?: (sessionId: string) => void;
  onMarkAllRead?: () => void;
  onDeleteSession: (sessionId: string) => void;
  onDeleteSessionStart?: (sessionId: string) => void;
  onDeleteSessionUndo?: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionPinned: (sessionId: string, pinned: boolean) => void;
  onSetSessionArchived: (sessionId: string, archived: boolean) => void;
  /** Open the skills and connectors library. */
  onShowSkills?: () => void;
  extensionsActive?: boolean;
  /** @deprecated */
  onShowMcp?: () => void;
  /** @deprecated */
  onShowPlugins?: () => void;
  onShowSettings: () => void;
  updateSupported: boolean;
  updateState: AppUpdaterState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onError: (message: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const mobile = useMobileLayout();
  type SwipeSource = "pointer" | "touch";
  type Swipe = { source: SwipeSource; id: number; startX: number; startY: number; horizontal: boolean; cancelled: boolean };
  const swipe = useRef<Swipe | null>(null);
  const updateSwipe = useCallback((gesture: Swipe, x: number, y: number) => {
    const deltaX = x - gesture.startX;
    const deltaY = y - gesture.startY;
    if (!gesture.horizontal && !gesture.cancelled && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 10) {
      if (Math.abs(deltaY) > Math.abs(deltaX) + 8 || deltaX >= 0) gesture.cancelled = true;
      else gesture.horizontal = true;
    }
    return { deltaX, deltaY };
  }, []);
  const closeSwipe = useCallback((gesture: Swipe, x: number, y: number) => {
    const { deltaX, deltaY } = updateSwipe(gesture, x, y);
    if (gesture.horizontal && !gesture.cancelled && deltaX <= -56 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) props.onClose?.();
  }, [props.onClose, updateSwipe]);
  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!mobile || !props.onClose || !event.isPrimary || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
    swipe.current = { source: "pointer", id: event.pointerId, startX: event.clientX, startY: event.clientY, horizontal: false, cancelled: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture is unavailable in some webviews. */ }
  }, [mobile, props.onClose]);
  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const gesture = swipe.current;
    if (!gesture || gesture.source !== "pointer" || gesture.id !== event.pointerId) return;
    const { deltaX } = updateSwipe(gesture, event.clientX, event.clientY);
    if (gesture.horizontal && deltaX < 0) event.preventDefault();
  }, [updateSwipe]);
  const finishPointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const gesture = swipe.current;
    if (!gesture || gesture.source !== "pointer" || gesture.id !== event.pointerId) return;
    swipe.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Pointer capture is unavailable in some webviews. */ }
    closeSwipe(gesture, event.clientX, event.clientY);
  }, [closeSwipe]);
  const onTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (!mobile || !props.onClose || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!touch) return;
    // Capacitor WebViews can expose touch events without PointerEvents. If
    // both APIs fire, the touch sequence owns the gesture and pointer events
    // are ignored until it finishes.
    swipe.current = { source: "touch", id: touch.identifier, startX: touch.clientX, startY: touch.clientY, horizontal: false, cancelled: false };
  }, [mobile, props.onClose]);
  const onTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const gesture = swipe.current;
    if (!gesture || gesture.source !== "touch") return;
    const touch = event.touches[0] ?? event.changedTouches[0];
    if (!touch || touch.identifier !== gesture.id) return;
    const { deltaX } = updateSwipe(gesture, touch.clientX, touch.clientY);
    if (gesture.horizontal && deltaX < 0 && event.cancelable) event.preventDefault();
  }, [updateSwipe]);
  const finishTouch = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const gesture = swipe.current;
    if (!gesture || gesture.source !== "touch") return;
    const touch = event.changedTouches[0];
    if (!touch || touch.identifier !== gesture.id) return;
    swipe.current = null;
    closeSwipe(gesture, touch.clientX, touch.clientY);
  }, [closeSwipe]);
  const cancelTouch = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const gesture = swipe.current;
    const touch = event.changedTouches[0];
    if (gesture?.source === "touch" && (!touch || touch.identifier === gesture.id)) swipe.current = null;
  }, []);
  const [moreOpen, setMoreOpen] = useState(false);
  const showSecondary = mobile && moreOpen;
  const [footerMenuOpen, setFooterMenuOpen] = useState(false);
  const footerMenuRef = useRef<HTMLButtonElement>(null);
  const openFeedback = () => void openExternalUrl(FEEDBACK_FORM_URL).catch((cause) => {
    props.onError(`无法打开反馈页面：${cause instanceof Error ? cause.message : String(cause)}`);
  });
  const [showArchived, setShowArchived] = useState(() => props.sessions.some((session) => session.id === props.currentSessionId && session.archived));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const [collapseAllVersion, setCollapseAllVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hostLabels = useMemo(() => new Map(props.hostGroups?.flatMap((host) => host.workspaceIds.map((id) => [id, host.label] as const))), [props.hostGroups]);
  const workspaceLabels = useMemo(() => new Map(props.workspaces.map((workspace) => [workspace.id,
    [hostLabels.get(workspace.id), workspace.name].filter(Boolean).join(" · ")])), [hostLabels, props.workspaces]);
  const navigation = useMemo(() => sidebarGroups(props.workspaces, props.sessions, props.unreadSessionIds, query, filter, hostLabels),
    [props.workspaces, props.sessions, props.unreadSessionIds, query, filter, hostLabels]);
  const previousSession = useRef({ id: props.currentSessionId, revealed: false });
  useEffect(() => {
    if (previousSession.current.id !== props.currentSessionId) {
      previousSession.current = { id: props.currentSessionId, revealed: false };
    }
    if (previousSession.current.revealed) return;
    const selected = props.sessions.find((session) => session.id === props.currentSessionId);
    if (!selected) return;
    previousSession.current.revealed = true;
    if (selected?.archived) setShowArchived(true);
  }, [props.currentSessionId, props.sessions]);
  const archivedSessions = navigation.archived;
  const archiveOpen = showArchived || navigation.filtering;
  const updateDividerVisible = props.updateSupported && updateNeedsAttention(props.updateState);
  const updateNoticeVisible = mobile || updateDividerVisible;
  return (
    <SidebarPanel
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={finishTouch}
      onTouchCancel={cancelTouch}
    >
      {mobile && <div className="sidebar-brand-row">
        <div className="sidebar-brand-lockup" data-tauri-drag-region>
          <span className="brand" data-tauri-drag-region>miniQ</span>
          <span className="sidebar-version">v2.4</span>
        </div>
        {props.onClose && <button type="button" className="sidebar-close" aria-label="关闭项目与会话侧栏" onClick={props.onClose}><X size={19} /></button>}
      </div>}
      <div className="sidebar-primary-actions">
      <button type="button" className="nav-item sidebar-nav-button sidebar-new-chat" aria-label="新对话" onClick={props.onNewChat} title="新对话（⌘/Ctrl+N）">
        <PencilLine className="nav-icon" size={16} /> 新对话
        <kbd className="sidebar-shortcut">⌘N</kbd>
      </button>
      {mobile ? <SidebarSearchField query={query} active={query !== "" || filter !== "all"}
        onQuery={setQuery} onClear={() => { setQuery(""); setFilter("all"); }}
        placeholder="搜索项目或会话内容..." mobile /> : <button type="button" className="nav-item sidebar-nav-button sidebar-search-button" onClick={props.onShowSearch}>
        <Search className="nav-icon" size={16} /> 搜索
      </button>}
      {!mobile && <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowSchedule}>
        <Clock3 className="nav-icon" size={16} /> 已安排
      </button>}
      {props.onShowSkills && <button type="button" className={`nav-item sidebar-nav-button sidebar-skills-button ${props.extensionsActive ? "active" : ""}`} aria-current={props.extensionsActive ? "page" : undefined} onClick={props.onShowSkills}>
        <Sparkles className="nav-icon" size={16} /> <span className="sidebar-skills-label">{mobile ? "技能中心" : "技能与连接器"}</span>
      </button>}
      {mobile && <button type="button" className={`nav-item sidebar-nav-button sidebar-running-button ${filter === "running" ? "active" : ""}`} aria-pressed={filter === "running"}
        aria-label={`快捷筛选：进行中 ${navigation.counts.running}`} onClick={() => setFilter(filter === "running" ? "all" : "running")}>
        <span className={`sidebar-running-dot${navigation.counts.running ? "" : " idle"}`} aria-hidden="true" /> <span>进行中</span><span className="sidebar-running-count">{navigation.counts.running}</span>
      </button>}
      </div>

      {props.workspaces.length > 0 && <SidebarFilters query={query} filter={filter} counts={navigation.counts}
        workspaceCount={navigation.groups.length} onQuery={setQuery} onFilter={setFilter}
        showQuery={!mobile} onMarkAllRead={props.onMarkAllRead} onCollapseAll={() => {
          setQuery(""); setFilter("all"); setCollapseAllVersion((value) => value + 1);
        }} />}
      <div ref={scrollRef} className="sidebar-scroll" role="navigation" aria-label="项目与会话" onKeyDown={handleSidebarNavigation}>
        <div ref={contentRef}>
        <SidebarAttention sessions={props.sessions} unreadSessionIds={props.unreadSessionIds} workspaceLabels={workspaceLabels} onSelectSession={props.onSelectSession} onClose={props.onClose} />
        {props.hostGroups?.filter((host) => !navigation.groups.some(({ workspace }) => host.workspaceIds.includes(workspace.id))).map((host) => <HostHeading key={host.key} host={host} />)}
        {navigation.groups.map(({ workspace, sessions }, index) => (
          <Fragment key={workspace.id}>
          {props.hostGroups?.filter((host) => host.workspaceIds.includes(workspace.id) && !navigation.groups.slice(0, index).some((group) => host.workspaceIds.includes(group.workspace.id))).map((host) => <HostHeading key={host.key} host={host} />)}
          <WorkspaceGroup
            currentSessionId={props.currentSessionId}
            key={workspace.id}
            selected={workspace.id === props.selectedWorkspaceId}
            sessions={sessions}
            scrollRef={scrollRef}
            contentRef={contentRef}
            collapseAllVersion={collapseAllVersion}
            filtering={navigation.filtering}
            unreadSessionIds={props.unreadSessionIds}
            workspace={workspace}
            onCreateSession={props.onCreateSession}
            onDeleteWorkspace={props.onDeleteWorkspace}
            onRenameWorkspace={props.onRenameWorkspace}
            onEditWorkspace={props.onEditWorkspace}
            canReveal={isTauriRuntime() && !props.hostGroups?.some((host) => host.local === false && host.workspaceIds.includes(workspace.id))}
            onError={props.onError}
            onSelectSession={props.onSelectSession}
            onSessionSeen={props.onSessionSeen}
            onSessionUnread={props.onSessionUnread}
            onDeleteSession={props.onDeleteSession}
            onDeleteSessionStart={props.onDeleteSessionStart}
            onDeleteSessionUndo={props.onDeleteSessionUndo}
            onRenameSession={props.onRenameSession}
            onSetSessionPinned={props.onSetSessionPinned}
            onSetSessionArchived={props.onSetSessionArchived}
            onSelectWorkspace={props.onSelectWorkspace}
          />
          </Fragment>
        ))}
        {props.workspaces.length === 0 && (!props.hostGroups?.length || props.hostGroups.every((host) => host.catalogStatus === "ready" && !host.catalogError && !host.error && host.state === "connected")) && (
          <EmptyState
            compact
            className="sidebar-empty"
            icon={<FolderPlus size={20} />}
            title="还没有项目"
            description="点击新对话选择或创建一个项目开始协作"
          />
        )}
        {navigation.filtering && navigation.groups.length === 0 && archivedSessions.length === 0 && (
          <EmptyState
            compact
            live
            className="sidebar-filter-empty"
            icon={<SearchX size={20} />}
            title="没有符合条件的会话"
            action={<button type="button" className="ghost" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选，查看全部</button>}
          />
        )}
        {archivedSessions.length > 0 && (
          <>
            <button
              type="button"
              className="session-toggle"
              aria-expanded={archiveOpen}
              disabled={navigation.filtering}
              onClick={() => setShowArchived((current) => !current)}
            >
              <Archive size={13} />
              <span>已归档 {archivedSessions.length}</span>
              {archiveOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {archiveOpen && <SidebarSessionList {...props} sessions={archivedSessions}
              scrollRef={scrollRef} contentRef={contentRef} workspaceLabels={workspaceLabels} />}
          </>
        )}
        </div>
      </div>

      <div className={`sidebar-footer${updateDividerVisible ? " has-update-notice" : ""}`}>
        {updateNoticeVisible && <UpdateNotice
          supported={props.updateSupported}
          state={props.updateState}
          onCheck={props.onCheckForUpdates}
          onInstall={props.onInstallUpdate}
        />}
        {showSecondary && <div className="sidebar-secondary-actions" id="sidebar-secondary-footer">
        <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowSearch}>
          <Search className="nav-icon" size={16} /> 搜索会话内容
        </button>
        {mobile && <button type="button" className="nav-item sidebar-nav-button" onClick={props.onShowSchedule}>
          <Clock3 className="nav-icon" size={16} /> 已安排
        </button>}
        <button type="button" className="nav-item sidebar-nav-button" onClick={props.onImportSessions}>
          <Download className="nav-icon" size={15} /> 导入会话
        </button>
        <button
          type="button"
          className="nav-item sidebar-nav-button"
          title="打开反馈表单"
          onClick={openFeedback}
        >
          <MessageSquareText className="nav-icon" size={16} /> 反馈
        </button>
        </div>}
        {mobile && <div className="sidebar-primary-actions sidebar-more-actions">
        <button type="button" className="nav-item sidebar-nav-button sidebar-more-card" aria-expanded={moreOpen}
          aria-controls="sidebar-secondary-footer" onClick={() => setMoreOpen((value) => !value)}>
          <MoreHorizontal className="nav-icon" size={16} /> <span className="sidebar-more-label">{moreOpen ? "收起功能" : "更多功能"}</span>
        </button>
        </div>}
        <div className={`sidebar-account-row${mobile ? "" : " desktop"}`}>
          <div className="sidebar-account" title="本机账户">
            <span className="sidebar-account-avatar" aria-hidden="true">Q</span>
            <span className="sidebar-account-status" aria-hidden="true"><span /></span>
            <span className="sidebar-account-copy"><span className="sidebar-account-name">本机</span><small>Localhost</small></span>
            <ChevronDown className="sidebar-account-chevron" size={14} aria-hidden="true" />
          </div>
          {!mobile && <>
            <button
              ref={footerMenuRef}
              type="button"
              className="icon-button sidebar-footer-more"
              aria-label="更多"
              aria-haspopup="menu"
              aria-expanded={footerMenuOpen}
              title="导入会话、反馈与更新"
              onClick={() => setFooterMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={16} />
            </button>
            <DropdownMenu triggerRef={footerMenuRef} open={footerMenuOpen} onClose={() => setFooterMenuOpen(false)}>
              <button type="button" className="dropdown-item" onClick={() => { setFooterMenuOpen(false); props.onImportSessions(); }}>
                <Download size={13} /><span>导入会话</span>
              </button>
              <button type="button" className="dropdown-item" onClick={() => { setFooterMenuOpen(false); openFeedback(); }}>
                <MessageSquareText size={13} /><span>反馈</span>
              </button>
              {props.updateSupported && <button type="button" className="dropdown-item" onClick={() => { setFooterMenuOpen(false); props.onCheckForUpdates(); }}>
                <RefreshCw size={13} /><span>{updateMenuLabel(props.updateState)}</span>
              </button>}
            </DropdownMenu>
          </>}
          <button type="button" className="nav-item sidebar-nav-button sidebar-settings-button" onClick={props.onShowSettings} title="设置（⌘/Ctrl+,）">
            <Settings className="nav-icon" size={16} /> <span className="sidebar-settings-label">设置</span>
          </button>
        </div>
      </div>
    </SidebarPanel>
  );
}

function HostHeading({ host }: { host: SidebarHostGroup }) {
  const state = { connected: "已连接", connecting: "连接中", disconnected: "未连接", error: "连接失败" }[host.state] ?? host.state;
  return <div className="sidebar-host" data-state={host.state}>
    <button type="button" className="sidebar-host-heading" aria-current={host.selected ? "location" : undefined} onClick={host.onSelect} title={host.error ?? `${host.label} · ${state}`}>
      <span>{host.label}</span><small>{state}</small>
    </button>
    {host.error && host.error !== host.catalogError && <p className="sidebar-host-error">{host.error}</p>}
    {host.catalogError && <p className="sidebar-host-error" role="alert">项目列表加载失败：{host.catalogError}</p>}
    {host.catalogStatus === "loading" && <p role="status">正在加载项目…</p>}
    {host.catalogStatus === "idle" && <p role="status">连接电脑后加载项目</p>}
    {host.catalogStatus === "ready" && !host.workspaceIds.length && <p>此电脑还没有项目</p>}
    {host.onRetry && host.catalogStatus === "error" && <button type="button" className="ghost" onClick={host.onRetry}>重试加载 {host.label} 的项目</button>}
  </div>;
}

/** Desktop keeps routine update states in the footer menu; only states that
 *  need the user's attention take a row of their own. */
export function updateNeedsAttention(state: AppUpdaterState): boolean {
  return state.phase !== "idle" && state.phase !== "up-to-date" && state.phase !== "unavailable";
}

function updateMenuLabel(state: AppUpdaterState): string {
  if (state.phase === "up-to-date") return `检查更新（已是最新${state.version ? ` v${state.version}` : ""}）`;
  if (state.phase === "unavailable") return "检查更新（当前平台暂无更新）";
  return "检查更新";
}
