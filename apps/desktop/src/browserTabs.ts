export interface BrowserTab {
  id: string;
  url: string;
  viewId?: string;
  browserSessionId?: string;
}

export interface BrowserTabsState {
  tabs: BrowserTab[];
  activeId: string | null;
  open: boolean;
}

export const EMPTY_BROWSER_TABS: BrowserTabsState = { tabs: [], activeId: null, open: false };

export function openBrowserTab(state: BrowserTabsState, url: string): BrowserTabsState {
  const tab = {
    id: crypto.randomUUID(),
    url,
    viewId: crypto.randomUUID().replaceAll("-", ""),
  };
  return { tabs: [...state.tabs, tab], activeId: tab.id, open: true };
}

export function updateBrowserTab(state: BrowserTabsState, id: string, url: string): BrowserTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, url } : tab)) };
}

export function openTaskBrowserTab(state: BrowserTabsState, browserSessionId: string, url: string): BrowserTabsState {
  const existing = state.tabs.find((tab) => tab.browserSessionId === browserSessionId);
  if (existing) {
    return { ...updateBrowserTab(state, existing.id, url), activeId: existing.id, open: true };
  }
  const opened = openBrowserTab(state, url);
  return {
    ...opened,
    tabs: opened.tabs.map((tab) => tab.id === opened.activeId ? { ...tab, browserSessionId } : tab),
  };
}

export function setTaskBrowserVisible(state: BrowserTabsState, browserSessionId: string, visible: boolean): BrowserTabsState {
  const tab = state.tabs.find((candidate) => candidate.browserSessionId === browserSessionId);
  if (!tab || (!visible && state.activeId !== tab.id)) return state;
  return { ...state, activeId: tab.id, open: visible };
}

export function closeBrowserTab(state: BrowserTabsState, id: string): BrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId = state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeId;
  return { tabs, activeId, open: state.open && tabs.length > 0 };
}
