import { expect, it } from "vitest";
import { EMPTY_PREVIEW_TABS, removePreviewTab, selectPreviewTab } from "./previewTabs";
const target = (path: string) => ({ path, line: null, column: null });
it("deduplicates by full path and closes to the adjacent tab", () => {
  let state = selectPreviewTab(EMPTY_PREVIEW_TABS, target("/a/report.md"));
  state = selectPreviewTab(state, target("/b/report.md"));
  state = selectPreviewTab(state, { ...target("/b/report.md"), line: 5 });
  expect(state.targets).toHaveLength(2);
  expect(state.targets[1].line).toBe(5);
  state = removePreviewTab(state, "/b/report.md");
  expect(state.active).toBe("/a/report.md");
  expect(removePreviewTab(state, "/a/report.md")).toEqual(EMPTY_PREVIEW_TABS);
});
