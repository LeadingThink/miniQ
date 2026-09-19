import { describe, expect, it } from "vitest";
import { closeBrowserTab, EMPTY_BROWSER_TABS, openBrowserTab, openTaskBrowserTab, setTaskBrowserVisible, updateBrowserTab } from "./browserTabs";

describe("browser tabs", () => {
  it("keeps independent URLs and selects the newest tab", () => {
    const first = openBrowserTab(EMPTY_BROWSER_TABS, "https://one.example/");
    const second = openBrowserTab(first, "https://two.example/");
    expect(second.tabs.map((tab) => tab.url)).toEqual(["https://one.example/", "https://two.example/"]);
    expect(second.activeId).toBe(second.tabs[1].id);
    expect(updateBrowserTab(second, second.tabs[0].id, "https://changed.example/").tabs[0].url).toBe("https://changed.example/");
  });

  it("selects a neighbor and closes the browser when its last tab closes", () => {
    const state = openBrowserTab(openBrowserTab(EMPTY_BROWSER_TABS, "https://one.example/"), "https://two.example/");
    const remaining = closeBrowserTab(state, state.tabs[1].id);
    expect(remaining.activeId).toBe(remaining.tabs[0].id);
    expect(closeBrowserTab(remaining, remaining.tabs[0].id)).toEqual(EMPTY_BROWSER_TABS);
  });

  it("presents the same task page after hiding and navigating without creating a separate preview", () => {
    const opened = openTaskBrowserTab(EMPTY_BROWSER_TABS, "task-1", "https://one.example/");
    const taskTab = opened.tabs[0];
    const hidden = setTaskBrowserVisible(opened, "task-1", false);
    expect(hidden.open).toBe(false);
    expect(hidden.tabs[0]).toBe(taskTab);
    const shown = setTaskBrowserVisible(hidden, "task-1", true);
    expect(shown.open).toBe(true);
    expect(shown.activeId).toBe(taskTab.id);
    const navigated = openTaskBrowserTab(shown, "task-1", "https://two.example/");
    expect(navigated.tabs).toEqual([{ ...taskTab, url: "https://two.example/" }]);
  });

  it("never hides a different active page when a background task requests invisibility", () => {
    const first = openTaskBrowserTab(EMPTY_BROWSER_TABS, "task-1", "https://one.example/");
    const manual = openBrowserTab(first, "https://manual.example/");
    expect(setTaskBrowserVisible(manual, "task-1", false)).toBe(manual);
    expect(setTaskBrowserVisible(manual, "missing-task", true)).toBe(manual);
    const shown = setTaskBrowserVisible(manual, "task-1", true);
    expect(shown.activeId).toBe(first.activeId);
    expect(shown.tabs).toBe(manual.tabs);
    expect(shown.open).toBe(true);
  });
});
