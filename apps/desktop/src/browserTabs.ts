export interface BrowserTab {
  id: string;
  url: string;
  viewId: string;
  browserSessionId?: string;
  /** Document title reported by the page; the label falls back to the host. */
  title?: string;
  /** viewId of the page that opened this tab (window.open / target=_blank). */
  openerViewId?: string;
}

export interface BrowserTabsState {
  tabs: BrowserTab[];
  activeId: string | null;
  open: boolean;
  taskActiveIds?: Record<string, string>;
}

export const EMPTY_BROWSER_TABS: BrowserTabsState = { tabs: [], activeId: null, open: false };

export const BROWSER_DRAFT_CREATED_EVENT = "miniq:browser-draft-created";
export interface BrowserDraftCreatedDetail {
  hostId: string | null;
  workspaceId: string;
  sessionId: string;
}

export function browserDraftScope(workspaceId?: string | null): string {
  return `draft:${workspaceId ?? ""}`;
}

/** Called only for the session just created from this draft, never on selection. */
export function adoptDraftBrowserTabs(
  sessions: Record<string, BrowserTabsState>, workspaceId: string, sessionId: string,
): Record<string, BrowserTabsState> {
  const draftScope = browserDraftScope(workspaceId);
  const draft = sessions[draftScope];
  if (!draft?.tabs.length || sessions[sessionId]) return sessions;
  const next = { ...sessions, [sessionId]: draft };
  delete next[draftScope];
  return next;
}

export function openBrowserTab(state: BrowserTabsState, url: string, browserSessionId?: string): BrowserTabsState {
  const tab = {
    id: crypto.randomUUID(),
    url,
    viewId: crypto.randomUUID().replaceAll("-", ""),
    ...(browserSessionId ? { browserSessionId } : {}),
  };
  return { ...state, tabs: [...state.tabs, tab], activeId: tab.id, open: true };
}

export function updateBrowserTab(state: BrowserTabsState, id: string, url: string): BrowserTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, url } : tab)) };
}

export function setBrowserTabTitle(state: BrowserTabsState, id: string, title: string): BrowserTabsState {
  const next = title.trim() || undefined;
  if (!state.tabs.some((tab) => tab.id === id && tab.title !== next)) return state;
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title: next } : tab)) };
}

/**
 * Opens a page popup (window.open / target=_blank) as a new focused tab. A
 * popup from an agent-owned tab stays in that agent's tab set and becomes its
 * selected page, like a browser focusing the new window.
 */
export function openPopupBrowserTab(state: BrowserTabsState, openerId: string, url: string): BrowserTabsState {
  const opener = state.tabs.find((tab) => tab.id === openerId);
  const opened = openBrowserTab(state, url, opener?.browserSessionId);
  const tab = { ...opened.tabs.at(-1)!, ...(opener ? { openerViewId: opener.viewId } : {}) };
  const next = { ...opened, tabs: [...opened.tabs.slice(0, -1), tab] };
  return opener?.browserSessionId ? selectTaskBrowserTab(next, opener.browserSessionId, tab, true) : next;
}

export function browserTabLabel(tab: Pick<BrowserTab, "url" | "title">): string {
  if (tab.title?.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).hostname || tab.url;
  } catch {
    return tab.url;
  }
}

export function taskBrowserTabs(state: BrowserTabsState, sessionId: string, browserSessionId: string): BrowserTab[] {
  return state.tabs.filter((tab) => tab.browserSessionId === browserSessionId ||
    (browserSessionId === sessionId && !tab.browserSessionId));
}

export function resolveTaskBrowserTab(
  state: BrowserTabsState, sessionId: string, browserSessionId: string, tabId?: string,
): BrowserTab | undefined {
  const tabs = taskBrowserTabs(state, sessionId, browserSessionId);
  if (tabId) {
    const tab = tabs.find((candidate) => candidate.viewId === tabId);
    if (!tab) throw new Error("浏览器标签页不存在或不属于当前任务；请重新列出 tabs");
    return tab;
  }
  // The main task shares the user's selected page. A child task keeps its own
  // selected page even when the user looks at another task or a manual tab.
  const preferred = browserSessionId === sessionId ? state.activeId : state.taskActiveIds?.[browserSessionId];
  return tabs.find((tab) => tab.id === preferred) ??
    tabs.find((tab) => tab.id === state.taskActiveIds?.[browserSessionId]) ?? tabs.at(-1);
}

export function selectTaskBrowserTab(state: BrowserTabsState, browserSessionId: string, tab: BrowserTab, reveal: boolean): BrowserTabsState {
  return {
    ...state,
    ...(reveal ? { activeId: tab.id, open: true } : {}),
    taskActiveIds: { ...state.taskActiveIds, [browserSessionId]: tab.id },
  };
}

export function closeBrowserTab(state: BrowserTabsState, id: string): BrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId = state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeId;
  const taskActiveIds = Object.fromEntries(Object.entries(state.taskActiveIds ?? {}).filter(([, active]) => active !== id));
  return { tabs, activeId, open: state.open && tabs.length > 0,
    ...(Object.keys(taskActiveIds).length ? { taskActiveIds } : {}),
  };
}
