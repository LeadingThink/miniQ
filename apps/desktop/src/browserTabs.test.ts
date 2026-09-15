import { describe, expect, it } from "vitest";
import { closeBrowserTab, EMPTY_BROWSER_TABS, openBrowserTab, updateBrowserTab } from "./browserTabs";

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
});
