export interface BrowserTab {
  id: string;
  url: string;
}

export interface BrowserTabsState {
  tabs: BrowserTab[];
  activeId: string | null;
  open: boolean;
}

export const EMPTY_BROWSER_TABS: BrowserTabsState = { tabs: [], activeId: null, open: false };

export function openBrowserTab(state: BrowserTabsState, url: string): BrowserTabsState {
  const tab = { id: crypto.randomUUID(), url };
  return { tabs: [...state.tabs, tab], activeId: tab.id, open: true };
}

export function updateBrowserTab(state: BrowserTabsState, id: string, url: string): BrowserTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, url } : tab)) };
}

export function closeBrowserTab(state: BrowserTabsState, id: string): BrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId = state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeId;
  return { tabs, activeId, open: state.open && tabs.length > 0 };
}
