import { describe, expect, it } from "vitest";
import { adoptDraftBrowserTabs, browserDraftScope, browserTabLabel, openPopupBrowserTab, setBrowserTabTitle, closeBrowserTab, EMPTY_BROWSER_TABS, openBrowserTab, resolveTaskBrowserTab, selectTaskBrowserTab, taskBrowserTabs, updateBrowserTab } from "./browserTabs";

describe("browser tabs", () => {
  it("keeps independent URLs and selects the newest tab", () => {
    const first = openBrowserTab(EMPTY_BROWSER_TABS, "https://one.example/");
    const second = openBrowserTab(first, "https://two.example/");
    expect(second.tabs.map((tab) => tab.url)).toEqual(["https://one.example/", "https://two.example/"]);
    expect(second.activeId).toBe(second.tabs[1].id);
    expect(updateBrowserTab(second, second.tabs[0].id, "https://changed.example/").tabs[0].url).toBe("https://changed.example/");
  });

  it("moves only the originating draft to its new session without rebuilding pages", () => {
    const draft = openBrowserTab(EMPTY_BROWSER_TABS, "https://form.example/");
    const other = openBrowserTab(EMPTY_BROWSER_TABS, "https://other.example/");
    const sessions = { [browserDraftScope("project")]: draft, [browserDraftScope("other")]: other };
    const adopted = adoptDraftBrowserTabs(sessions, "project", "created-session");
    expect(adopted["created-session"]).toBe(draft);
    expect(adopted["created-session"].tabs[0]).toBe(draft.tabs[0]);
    expect(adopted[browserDraftScope("project")]).toBeUndefined();
    expect(adopted[browserDraftScope("other")]).toBe(other);
    expect(adoptDraftBrowserTabs(adopted, "project", "another-session")).toBe(adopted);
  });

  it("does not overwrite browser state that already belongs to an existing session", () => {
    const draft = openBrowserTab(EMPTY_BROWSER_TABS, "https://draft.example/");
    const existing = openBrowserTab(EMPTY_BROWSER_TABS, "https://existing.example/");
    const sessions = { [browserDraftScope("project")]: draft, existing };
    expect(adoptDraftBrowserTabs(sessions, "project", "existing")).toBe(sessions);
  });

  it("selects a neighbor and closes the browser when its last tab closes", () => {
    const state = openBrowserTab(openBrowserTab(EMPTY_BROWSER_TABS, "https://one.example/"), "https://two.example/");
    const remaining = closeBrowserTab(state, state.tabs[1].id);
    expect(remaining.activeId).toBe(remaining.tabs[0].id);
    expect(closeBrowserTab(remaining, remaining.tabs[0].id)).toEqual(EMPTY_BROWSER_TABS);
  });

  it("shares selected manual pages with only the main task", () => {
    const first = openBrowserTab(EMPTY_BROWSER_TABS, "https://one.example/");
    const state = openBrowserTab(first, "https://two.example/");
    expect(resolveTaskBrowserTab(state, "session", "session")).toBe(state.tabs[1]);
    expect(resolveTaskBrowserTab(state, "session", "session", state.tabs[0].viewId)).toBe(state.tabs[0]);
    expect(taskBrowserTabs(state, "session", "session:child")).toEqual([]);
    expect(() => resolveTaskBrowserTab(state, "session", "session:child", state.tabs[0].viewId)).toThrow("不属于当前任务");
  });

  it("keeps a child task's selected page while users browse another page", () => {
    const first = openBrowserTab(EMPTY_BROWSER_TABS, "https://one.example/", "session:child");
    const second = openBrowserTab(first, "https://two.example/", "session:child");
    const selected = selectTaskBrowserTab(second, "session:child", first.tabs[0], true);
    const manual = openBrowserTab(selected, "https://manual.example/");
    expect(resolveTaskBrowserTab(manual, "session", "session:child")).toBe(first.tabs[0]);
    expect(resolveTaskBrowserTab(manual, "session", "session")).toBe(manual.tabs[2]);
    const closed = closeBrowserTab(manual, first.tabs[0].id);
    expect(resolveTaskBrowserTab(closed, "session", "session:child")).toBe(second.tabs[1]);
    expect(closed.taskActiveIds?.["session:child"]).toBeUndefined();
  });
});

describe("page titles and popups", () => {
  it("labels tabs by title with a hostname fallback", () => {
    const state = openBrowserTab(EMPTY_BROWSER_TABS, "https://docs.example/guide");
    const id = state.tabs[0].id;
    expect(browserTabLabel(state.tabs[0])).toBe("docs.example");
    const titled = setBrowserTabTitle(state, id, "  使用指南  ");
    expect(browserTabLabel(titled.tabs[0])).toBe("使用指南");
    expect(setBrowserTabTitle(titled, id, "使用指南")).toBe(titled);
    expect(browserTabLabel(setBrowserTabTitle(titled, id, "").tabs[0])).toBe("docs.example");
  });

  it("opens a manual page popup as a new focused tab", () => {
    const state = openBrowserTab(openBrowserTab(EMPTY_BROWSER_TABS, "https://a.example/"), "https://b.example/");
    const opener = state.tabs[0];
    const next = openPopupBrowserTab({ ...state, activeId: opener.id }, opener.id, "https://login.example/");
    const popup = next.tabs.at(-1)!;
    expect(next.tabs).toHaveLength(3);
    expect(next.activeId).toBe(popup.id);
    expect(popup).toMatchObject({ url: "https://login.example/", openerViewId: opener.viewId });
    expect(popup.browserSessionId).toBeUndefined();
  });

  it("keeps an agent popup in the agent's tab set and selects it for the agent", () => {
    const agent = openBrowserTab(EMPTY_BROWSER_TABS, "https://task.example/", "child-task");
    const opener = agent.tabs[0];
    const next = openPopupBrowserTab(selectTaskBrowserTab(agent, "child-task", opener, true), opener.id, "https://popup.example/");
    const popup = next.tabs.at(-1)!;
    expect(popup.browserSessionId).toBe("child-task");
    expect(next.activeId).toBe(popup.id);
    expect(next.taskActiveIds?.["child-task"]).toBe(popup.id);
    expect(taskBrowserTabs(next, "main", "child-task").map((tab) => tab.url)).toEqual(["https://task.example/", "https://popup.example/"]);
    expect(resolveTaskBrowserTab(next, "main", "child-task")?.id).toBe(popup.id);
  });
});
